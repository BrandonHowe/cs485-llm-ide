/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { VSCloneModelVendor } from './vscloneOAuthTypes.js';

/**
 * Some provider accounts silently lack access to specific models. Codex-on-ChatGPT, for example,
 * rejects `gpt-5.3-codex-spark` with a 400 unless the user's ChatGPT tier includes Spark. Rather
 * than repeatedly presenting a model that is known to fail for the current identity, we persist
 * the discovered ineligibility and let the catalog hide those entries from the picker until the
 * user signs out (suggesting they may have switched accounts or upgraded their plan).
 */
export interface IVSCloneModelIneligibilityRecord {
	readonly modelIdentifier: string;
	readonly reason: string;
	readonly markedAt: number;
}

export interface IVSCloneModelEligibilityService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeEligibility: Event<void>;
	initialize(): Promise<void>;
	isIneligible(modelIdentifier: string): boolean;
	getIneligibilityRecord(modelIdentifier: string): IVSCloneModelIneligibilityRecord | undefined;
	markIneligible(modelIdentifier: string, reason: string): void;
	clearForVendor(vendor: VSCloneModelVendor): void;
	clearAll(): void;
}

export const IVSCloneModelEligibilityService = createDecorator<IVSCloneModelEligibilityService>('vscloneModelEligibilityService');

interface IVSCloneModelEligibilityStorage {
	version: 1;
	records: Record<string, { reason: string; markedAt: number }>;
}

const modelEligibilityStorageKey = 'vsclone.modelEligibility.v1';

function parseStorage(raw: string | undefined): Map<string, IVSCloneModelIneligibilityRecord> {
	const records = new Map<string, IVSCloneModelIneligibilityRecord>();
	if (!raw) {
		return records;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<IVSCloneModelEligibilityStorage> | undefined;
		if (!parsed || parsed.version !== 1 || typeof parsed.records !== 'object' || !parsed.records) {
			return records;
		}
		for (const [identifier, entry] of Object.entries(parsed.records)) {
			if (!entry || typeof entry.reason !== 'string' || typeof entry.markedAt !== 'number') {
				continue;
			}
			records.set(identifier, { modelIdentifier: identifier, reason: entry.reason, markedAt: entry.markedAt });
		}
	} catch {
		// Ignore malformed persisted state - the next write rewrites a clean shape.
	}

	return records;
}

function toStorageShape(records: ReadonlyMap<string, IVSCloneModelIneligibilityRecord>): IVSCloneModelEligibilityStorage {
	const shape: IVSCloneModelEligibilityStorage = { version: 1, records: {} };
	for (const [identifier, record] of records) {
		shape.records[identifier] = { reason: record.reason, markedAt: record.markedAt };
	}
	return shape;
}

function vendorForIdentifier(modelIdentifier: string): VSCloneModelVendor | undefined {
	const slash = modelIdentifier.indexOf('/');
	if (slash <= 0) {
		return undefined;
	}
	const prefix = modelIdentifier.slice(0, slash);
	if (prefix === 'openai' || prefix === 'anthropic' || prefix === 'google') {
		return prefix;
	}
	return undefined;
}

export class VSCloneModelEligibilityService extends Disposable implements IVSCloneModelEligibilityService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeEligibility = this._register(new Emitter<void>());
	readonly onDidChangeEligibility = this._onDidChangeEligibility.event;

	private initialized = false;
	private records = new Map<string, IVSCloneModelIneligibilityRecord>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	async initialize(): Promise<void> {
		this.ensureInitialized();
	}

	isIneligible(modelIdentifier: string): boolean {
		this.ensureInitialized();
		return this.records.has(modelIdentifier);
	}

	getIneligibilityRecord(modelIdentifier: string): IVSCloneModelIneligibilityRecord | undefined {
		this.ensureInitialized();
		return this.records.get(modelIdentifier);
	}

	markIneligible(modelIdentifier: string, reason: string): void {
		this.ensureInitialized();
		const existing = this.records.get(modelIdentifier);
		if (existing && existing.reason === reason) {
			return;
		}
		this.records.set(modelIdentifier, {
			modelIdentifier,
			reason,
			markedAt: Date.now(),
		});
		this.store();
		this._onDidChangeEligibility.fire();
	}

	clearForVendor(vendor: VSCloneModelVendor): void {
		this.ensureInitialized();
		let changed = false;
		for (const identifier of [...this.records.keys()]) {
			if (vendorForIdentifier(identifier) === vendor) {
				this.records.delete(identifier);
				changed = true;
			}
		}
		if (changed) {
			this.store();
			this._onDidChangeEligibility.fire();
		}
	}

	clearAll(): void {
		this.ensureInitialized();
		if (this.records.size === 0) {
			return;
		}
		this.records.clear();
		this.store();
		this._onDidChangeEligibility.fire();
	}

	/**
	 * Lazy synchronous hydration. `initialize()` remains on the interface for symmetry with the
	 * other VSClone services, but we load storage on demand here so an error-path mutation that
	 * beats the workbench bootstrap cannot overwrite persisted state with an empty snapshot.
	 */
	private ensureInitialized(): void {
		if (this.initialized) {
			return;
		}
		this.records = parseStorage(this.storageService.get(modelEligibilityStorageKey, StorageScope.PROFILE));
		this.initialized = true;
	}

	private store(): void {
		const data = JSON.stringify(toStorageShape(this.records));
		// Machine-scoped target because ineligibility is tied to the account that is currently signed
		// in on this device; syncing it across profiles would risk hiding models that another machine's
		// identity is perfectly entitled to see.
		this.storageService.store(modelEligibilityStorageKey, data, StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}
