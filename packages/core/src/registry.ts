/**
 * 渠道注册表实现：新渠道 = 实现接口 + register，主流程零改动。
 */
import type { Channel, ChannelRegistry } from "./channel.js";

export class DefaultChannelRegistry implements ChannelRegistry {
  private readonly channels = new Map<string, Channel>();

  register(channel: Channel): void {
    if (this.channels.has(channel.id)) {
      throw new Error(`渠道重复注册: ${channel.id}`);
    }
    this.channels.set(channel.id, channel);
  }

  get(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  all(): Channel[] {
    return [...this.channels.values()];
  }
}

/** 全局默认注册表（CLI/测试均可注入独立实例） */
export const registry = new DefaultChannelRegistry();
