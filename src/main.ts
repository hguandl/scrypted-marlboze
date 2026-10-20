import sdk, {
    DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase,
    ScryptedDeviceType, ScryptedInterface, Setting,
} from '@scrypted/sdk';
import { randomUUID } from 'node:crypto';
import { Config, validate } from './protocol/config';
import { MarlbozeCamera } from './device/camera';
import { settings } from './device/settings';

const { deviceManager } = sdk;
const interfaces = [ScryptedInterface.VideoCamera, ScryptedInterface.Settings, ScryptedInterface.MotionSensor];

class MarlbozeProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    systemDevice = { deviceCreator: 'Marlboze Camera' };
    private cameras = new Map<string, MarlbozeCamera>();

    constructor() {
        super();
        for (const nativeId of deviceManager.getNativeIds())
            if (nativeId) void this.restoreDevice(nativeId).catch(error =>
                this.console.error('Unable to restore camera:', error.message));
    }

    private async restoreDevice(nativeId: string): Promise<void> {
        const state = deviceManager.getDeviceState(nativeId);
        // Existing video-only devices also need the new motion declaration.
        if (!state.providedInterfaces.includes(ScryptedInterface.MotionSensor)) {
            await deviceManager.onDeviceDiscovered({
                nativeId, name: state.providedName || state.name || 'Marlboze',
                type: ScryptedDeviceType.Camera, interfaces, info: state.info,
            });
        }
        await this.getDevice(nativeId);
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [{ key: 'name', title: 'Name', value: 'Marlboze' }, ...settings()];
    }

    async createDevice(values: DeviceCreatorSettings): Promise<string> {
        const config: Config = {
            uid: String(values.uid || ''), mac: String(values.mac || ''), password: String(values.password || ''),
            ip: String(values.ip || ''), stream: Number(values.stream ?? 0),
        };
        validate(config);
        const nativeId = randomUUID();
        await deviceManager.onDeviceDiscovered({
            nativeId, name: String(values.name || 'Marlboze'), type: ScryptedDeviceType.Camera,
            interfaces,
            info: { manufacturer: 'Marlboze' },
        });
        (await this.getDevice(nativeId)).configure(config);
        return nativeId;
    }

    async getDevice(nativeId: string): Promise<MarlbozeCamera> {
        let camera = this.cameras.get(nativeId);
        if (!camera) { camera = new MarlbozeCamera(nativeId); this.cameras.set(nativeId, camera); }
        return camera;
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        try { this.cameras.get(nativeId)?.release(); }
        finally { this.cameras.delete(nativeId); }
    }
}

export default new MarlbozeProvider();
