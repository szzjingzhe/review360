/**
 * 前端只使用真实后端。接口未实现时直接失败，不回退到内存数据。
 */
import { realApi, realUserName } from './real.js';

export const USE_MOCK = false;
export const mockApi = realApi;
export const userName = realUserName;

export type { MockApi } from '../mock/api.js';
