import sdk, {
    MediaObject, RequestMediaStreamOptions, ResponseMediaStreamOptions, ScryptedDeviceBase,
    ScryptedInterface, Setting, Settings, SettingValue, VideoCamera, MotionSensor,
} from '@scrypted/sdk';
import { Config, validate } from '../protocol/config';
import { MediaSession, Metadata } from '../media/session';
import { MotionMonitor } from './motion';
import { fields, settings, DEFAULT_MOTION_TIMEOUT, validateMotionTimeout } from './settings';

const { mediaManager } = sdk;

export class MarlbozeCamera extends ScryptedDeviceBase implements VideoCamera, Settings, MotionSensor {
    private sessions = new Set<MediaSession>();
    private metadata: Metadata = {};
    private motion: MotionMonitor;

    constructor(nativeId: string) {
        super(nativeId);
        this.loadMetadata();
        this.motionDetected = false;
        this.motion = new MotionMonitor(value => { this.motionDetected = value; },
            (message, details) => {
                if (this.storage.getItem('debug') === 'true')
                    this.console.log(`[marlboze] alarm ${message}`, details || '');
            }, error => this.console.warn('[marlboze] alarm connection ended:', error.message));
        this.startAlarms();
    }

    private motionTimeout(): number {
        const value = Number(this.storage.getItem('motionTimeout') ?? DEFAULT_MOTION_TIMEOUT);
        try { validateMotionTimeout(value); return value; }
        catch { return DEFAULT_MOTION_TIMEOUT; }
    }

    private startAlarms(): void {
        const config = this.config();
        try { validate(config); } catch { return; }
        this.motion.start(config, this.motionTimeout());
    }

    private config(): Config {
        return {
            uid: this.storage.getItem('uid') || '', mac: this.storage.getItem('mac') || '',
            password: this.storage.getItem('password') || '', ip: this.storage.getItem('ip') || '',
            stream: Number(this.storage.getItem('stream') || 0),
        };
    }

    private loadMetadata(): void {
        try {
            const saved = JSON.parse(this.storage.getItem('metadata') || '{}');
            for (const key of ['width', 'height'] as const)
                if (Number.isInteger(saved?.[key]) && saved[key] > 0 && saved[key] <= 65535)
                    this.metadata[key] = saved[key];
        }
        catch { this.metadata = {}; }
    }

    private streamOptions(): ResponseMediaStreamOptions {
        const config = this.config();
        return {
            id: String(config.stream), name: `Stream ${config.stream}`, source: 'local',
            video: { codec: 'h265', width: this.metadata.width, height: this.metadata.height,
                bitrate: this.metadata.bitrate },
            audio: { codec: 'pcm_alaw', sampleRate: 8000 },
        };
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [this.streamOptions()];
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const config = this.config();
        validate(config);
        if (options?.id && options.id !== String(config.stream)) throw new Error('Unknown stream');
        if (options?.refresh === false) throw new Error('Use Rebroadcast for snapshots of an active stream');
        const session = new MediaSession(config, (message, details) => {
            if (this.storage.getItem('debug') === 'true' || message === 'media ready' || message === 'session ended')
                this.console.log(`[marlboze] ${message}`, details || '');
        }, () => this.sessions.delete(session), metadata => {
            Object.assign(this.metadata, metadata);
            // Persist dimensions only; measured bitrate/interval are live estimates.
            if (metadata.width && metadata.height)
                this.storage.setItem('metadata', JSON.stringify({ width: metadata.width, height: metadata.height }));
        });
        this.sessions.add(session);
        const { url, sdp } = await session.open();
        const mediaStreamOptions = this.streamOptions();
        mediaStreamOptions.sdp = sdp;
        mediaStreamOptions.oobCodecParameters = true;
        try {
            return await mediaManager.createMediaObject(Buffer.from(JSON.stringify({ url, sdp, mediaStreamOptions })),
                'x-scrypted/x-rfc4571', { sourceId: this.id });
        }
        catch (error) { session.close(); throw error; }
    }

    async getSettings(): Promise<Setting[]> {
        return [
            ...settings(this.config()),
            { key: 'motionTimeout', title: 'Motion Reset Time', type: 'number', value: this.motionTimeout(),
                description: 'Seconds after the last local alarm before motion resets. Default: 30.' },
            { key: 'debug', title: 'Debug', type: 'boolean', value: this.storage.getItem('debug') === 'true' },
            { key: 'media', title: 'Detected Media', readonly: true,
                value: JSON.stringify(this.metadata), description: 'Dimensions from SPS; bitrate in bit/s; keyframe interval in ms.' },
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'debug') this.storage.setItem(key, String(value));
        else if (key === 'motionTimeout') {
            const seconds = Number(value);
            validateMotionTimeout(seconds);
            this.storage.setItem(key, String(seconds));
            this.motion.setTimeout(seconds);
        }
        else {
            if (!fields.includes(key as typeof fields[number])) throw new Error('Unknown setting');
            const config = { ...this.config(), [key]: key === 'stream' ? Number(value) : String(value) };
            validate(config);
            this.release();
            this.storage.setItem(key, String(value));
            this.metadata = {};
            this.storage.removeItem('metadata');
            this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
            this.startAlarms();
        }
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    configure(config: Config): void {
        validate(config);
        this.release();
        for (const field of fields) this.storage.setItem(field, String(config[field]));
        this.startAlarms();
    }

    release(): void {
        const errors: unknown[] = [];
        try { this.motion.stop(); } catch (error) { errors.push(error); }
        for (const session of this.sessions) {
            try { session.close(); } catch (error) { errors.push(error); }
        }
        this.sessions.clear();
        if (errors.length) throw new AggregateError(errors, 'Camera resource cleanup failed');
    }
}

