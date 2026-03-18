/**
 * Maps container bridge IP addresses to group identity.
 *
 * When a permissionApproval container starts, its IP on the nanoclaw-proxy
 * bridge is registered here. The credential proxy calls resolveContainerGroup
 * with req.socket.remoteAddress to identify which group's container is making
 * a request, so it can send the Telegram approval message to the right chat.
 */

export interface ContainerGroupEntry {
  groupFolder: string;
  chatJid: string;
}

const registry = new Map<string, ContainerGroupEntry>();

export function registerContainerGroup(
  ip: string,
  entry: ContainerGroupEntry,
): void {
  registry.set(ip, entry);
}

export function deregisterContainerGroup(ip: string): void {
  registry.delete(ip);
}

/**
 * Look up the group for a connection's remote address.
 * Handles IPv4-mapped IPv6 addresses (::ffff:172.19.0.2 → 172.19.0.2).
 */
export function resolveContainerGroup(
  remoteAddress: string,
): ContainerGroupEntry | null {
  const ip = remoteAddress.replace(/^::ffff:/, '');
  return registry.get(ip) ?? null;
}

/** @internal — for tests only */
export function _clearRegistry(): void {
  registry.clear();
}
