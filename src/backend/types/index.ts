/**
 * Shared backend boundary (Phase 1: interfaces only — no backend is
 * implemented or contacted in this phase).
 *
 * The future remote backend will provide authentication, users, invites,
 * shared workspace/memory/chat, notifications, usage and synchronization.
 *
 * Architecture: local/offline → remote backend → synchronization.
 * Personal local data must never be uploaded automatically; sharing is
 * always explicit and scoped to shared resources.
 */

export type BackendConnectionState = 'offline' | 'connecting' | 'connected' | 'error';

export interface BackendStatus {
	readonly state: BackendConnectionState;
	readonly message?: string;
}

export interface BackendClient {
	getStatus(): BackendStatus;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
}

export interface SyncPolicy {
	/**
	 * Literal `false`: personal memory is architecturally excluded from
	 * automatic synchronization (local-first guarantee).
	 */
	readonly includePersonalMemory: false;
	readonly includeSharedWorkspace: boolean;
	readonly includeSharedChat: boolean;
}

/**
 * Default policy: everything local, nothing shared.
 */
export const LOCAL_ONLY_SYNC_POLICY: SyncPolicy = {
	includePersonalMemory: false,
	includeSharedWorkspace: false,
	includeSharedChat: false,
};
