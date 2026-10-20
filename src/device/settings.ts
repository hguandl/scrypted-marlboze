import { Setting } from '@scrypted/sdk';
import { Config } from '../protocol/config';

export const fields = ['uid', 'mac', 'password', 'ip', 'stream'] as const;

export function settings(config?: Config): Setting[] {
    return [
        { key: 'ip', title: 'IP Address', value: config?.ip },
        { key: 'uid', title: 'UID', value: config?.uid },
        { key: 'mac', title: 'MAC Address', placeholder: '02-00-00-00-00-01', value: config?.mac },
        { key: 'password', title: 'Device Password', type: 'password', value: config?.password },
        { key: 'stream', title: 'Stream', type: 'number', value: config?.stream ?? 0,
            description: 'Device stream selector. Verified: 0 low resolution, 1 high resolution.' },
    ];
}

export const DEFAULT_MOTION_TIMEOUT = 30;

export function validateMotionTimeout(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 2147483)
        throw new Error('Motion reset time must be positive and no greater than 2147483 seconds');
}
