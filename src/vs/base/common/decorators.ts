/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface IModernDecoratorContext {
	readonly kind: 'getter' | 'method';
	readonly name: string | symbol;
}

type DecoratedFunction = (...args: unknown[]) => unknown;

/**
 * Keep shared decorators compatible with both legacy descriptor decorators and
 * the modern `__esDecorate` calling convention. The `out/` tree can mix both
 * shapes while TypeScript/compiler settings change, so central helpers must
 * understand either runtime form to avoid load-time crashes.
 */
function isModernDecoratorContext(value: string | symbol | IModernDecoratorContext): value is IModernDecoratorContext {
	return typeof value === 'object'
		&& value !== null
		&& 'kind' in value
		&& 'name' in value
		&& (value.kind === 'getter' || value.kind === 'method');
}

function getDecoratorKey(key: string | symbol): string {
	if (typeof key === 'symbol') {
		throw new Error('not supported');
	}

	return key;
}

function createDecorator(mapFn: (fn: DecoratedFunction, key: string) => DecoratedFunction): MethodDecorator {
	return ((targetOrValue: Object | DecoratedFunction, keyOrContext: string | symbol | IModernDecoratorContext, descriptor?: PropertyDescriptor) => {
		if (isModernDecoratorContext(keyOrContext)) {
			if (typeof targetOrValue !== 'function') {
				throw new Error('not supported');
			}

			return mapFn(targetOrValue, getDecoratorKey(keyOrContext.name));
		}

		if (typeof descriptor?.value === 'function') {
			descriptor.value = mapFn(descriptor.value, getDecoratorKey(keyOrContext));
			return;
		}

		if (typeof descriptor?.get === 'function') {
			descriptor.get = mapFn(descriptor.get, getDecoratorKey(keyOrContext));
			return;
		}

		throw new Error('not supported');
	}) as MethodDecorator;
}

function createMemoizedFunction(fn: DecoratedFunction, key: string): DecoratedFunction {
	if (fn.length !== 0) {
		console.warn('Memoize should only be used in functions with zero parameters');
	}

	const memoizeKey = `$memoize$${key}`;
	return function (this: object, ...args: unknown[]) {
		const target = this as Record<string, unknown>;
		if (!Object.prototype.hasOwnProperty.call(target, memoizeKey)) {
			Object.defineProperty(target, memoizeKey, {
				configurable: false,
				enumerable: false,
				writable: false,
				value: fn.apply(this, args)
			});
		}

		return target[memoizeKey];
	};
}

export function memoize(targetOrValue: Object | DecoratedFunction, keyOrContext: string | symbol | IModernDecoratorContext, descriptor?: PropertyDescriptor) {
	if (isModernDecoratorContext(keyOrContext)) {
		if (typeof targetOrValue !== 'function') {
			throw new Error('not supported');
		}

		return createMemoizedFunction(targetOrValue, getDecoratorKey(keyOrContext.name));
	}

	if (typeof descriptor?.value === 'function') {
		descriptor.value = createMemoizedFunction(descriptor.value, getDecoratorKey(keyOrContext));
		return;
	}

	if (typeof descriptor?.get === 'function') {
		descriptor.get = createMemoizedFunction(descriptor.get, getDecoratorKey(keyOrContext));
		return;
	}

	throw new Error('not supported');
}

export interface IDebounceReducer<T> {
	(previousValue: T, ...args: any[]): T;
}

export function debounce<T>(delay: number, reducer?: IDebounceReducer<T>, initialValueProvider?: () => T) {
	return createDecorator((fn, key) => {
		const timerKey = `$debounce$${key}`;
		const resultKey = `$debounce$result$${key}`;

		return function (this: any, ...args: any[]) {
			if (!this[resultKey]) {
				this[resultKey] = initialValueProvider ? initialValueProvider() : undefined;
			}

			clearTimeout(this[timerKey]);

			if (reducer) {
				this[resultKey] = reducer(this[resultKey], ...args);
				args = [this[resultKey]];
			}

			this[timerKey] = setTimeout(() => {
				fn.apply(this, args);
				this[resultKey] = initialValueProvider ? initialValueProvider() : undefined;
			}, delay);
		};
	});
}

export function throttle<T>(delay: number, reducer?: IDebounceReducer<T>, initialValueProvider?: () => T) {
	return createDecorator((fn, key) => {
		const timerKey = `$throttle$timer$${key}`;
		const resultKey = `$throttle$result$${key}`;
		const lastRunKey = `$throttle$lastRun$${key}`;
		const pendingKey = `$throttle$pending$${key}`;

		return function (this: any, ...args: any[]) {
			if (!this[resultKey]) {
				this[resultKey] = initialValueProvider ? initialValueProvider() : undefined;
			}
			if (this[lastRunKey] === null || this[lastRunKey] === undefined) {
				this[lastRunKey] = -Number.MAX_VALUE;
			}

			if (reducer) {
				this[resultKey] = reducer(this[resultKey], ...args);
			}

			if (this[pendingKey]) {
				return;
			}

			const nextTime = this[lastRunKey] + delay;
			if (nextTime <= Date.now()) {
				this[lastRunKey] = Date.now();
				fn.apply(this, [this[resultKey]]);
				this[resultKey] = initialValueProvider ? initialValueProvider() : undefined;
			} else {
				this[pendingKey] = true;
				this[timerKey] = setTimeout(() => {
					this[pendingKey] = false;
					this[lastRunKey] = Date.now();
					fn.apply(this, [this[resultKey]]);
					this[resultKey] = initialValueProvider ? initialValueProvider() : undefined;
				}, nextTime - Date.now());
			}
		};
	});
}

export { cancelPreviousCalls } from './decorators/cancelPreviousCalls.js';
