import { Client } from '../protocol/client';
import { Config, Log } from '../protocol/config';
import { DEFAULT_MOTION_TIMEOUT, validateMotionTimeout } from './settings';

// Owns the login-only connection and the last-alarm reset deadline.
export class MotionMonitor {
    private client?: Client;
    private reconnect?: NodeJS.Timeout;
    private timer?: NodeJS.Timeout;
    private lastAlarm?: number;
    private seconds = DEFAULT_MOTION_TIMEOUT;

    constructor(private onMotion: (detected: boolean) => void, private log: Log,
        private onError: (error: Error) => void) {}

    start(config: Config, seconds: number): void {
        validateMotionTimeout(seconds);
        this.stop();
        this.seconds = seconds;
        this.connect(config);
    }

    private connect(config: Config): void {
        const client = new Client(config, this.log);
        this.client = client;
        client.on('alarm', () => {
            if (this.client !== client) return;
            this.lastAlarm = Date.now();
            this.onMotion(true);
            this.scheduleReset();
        });
        client.once('end', (error?: Error) => {
            if (this.client !== client) return;
            this.client = undefined;
            if (error) this.onError(error);
            this.reconnect = setTimeout(() => {
                this.reconnect = undefined;
                this.connect(config);
            }, 5000);
        });
        // Client.open reports failures through end; the handler owns retries.
        void client.open(false).catch(() => {});
    }

    setTimeout(seconds: number): void {
        validateMotionTimeout(seconds);
        this.seconds = seconds;
        this.scheduleReset();
    }

    private scheduleReset(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (this.lastAlarm === undefined) return;
        const remaining = this.lastAlarm + this.seconds * 1000 - Date.now();
        if (remaining > 0) {
            this.timer = setTimeout(() => this.scheduleReset(), remaining);
            return;
        }
        this.lastAlarm = undefined;
        this.onMotion(false);
    }

    stop(): void {
        clearTimeout(this.reconnect);
        clearTimeout(this.timer);
        this.reconnect = this.timer = undefined;
        const client = this.client;
        this.client = undefined;
        client?.close();
        this.lastAlarm = undefined;
        // Scrypted may already have removed the device state during release.
        try { this.onMotion(false); } catch { /* Resources are already stopped. */ }
    }
}
