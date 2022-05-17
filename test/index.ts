import {assert} from 'chai'
import {writable} from 'svelte/store'
import type {Readable} from 'svelte/store'

import * as lib from '$lib'

suite('channel store', function () {
    const deferred: Array<() => void> = []
    function defer(...fn: (() => void)[]) {
        deferred.push(...fn)
    }
    this.afterEach(() => {
        while (deferred.length) {
            deferred.shift()!()
        }
    })

    test('primary -> replicated', async function () {
        const {replicated, primary, cleanup} = getTestPair('test', 0)
        defer(cleanup)
        primary.set(42)
        await assertStream(replicated, [0, 42]) // first value will always be initial value
    })

    test('replicated -> primary', async function () {
        const {replicated, primary, cleanup} = getTestPair('test', 0)
        defer(cleanup)
        replicated.set(42)
        await assertStream(primary, [0, 42])
    })

    test('replicated -> replicated', async function () {
        const p1 = getTestPair('test', 0)
        const p2 = getTestPair('test', 0)
        p1.primary.attach(p2.channel.port1)
        defer(p1.cleanup, p2.cleanup, () => p1.primary.detach(p2.channel.port1))
        p1.replicated.set(42)
        await assertStream(p2.replicated, [0, 42])
    })

    test('multiple stores on same channel', async function () {
        const p1 = getTestPair('test1', 1)
        const p2 = getTestPair('test2', 2, p1.channel)
        defer(p1.cleanup, p2.cleanup)
        p1.primary.set(11)
        p2.primary.set(22)
        await Promise.all([
            assertStream(p1.replicated, [1, 11]),
            assertStream(p2.replicated, [2, 22]),
        ])
    })
})

function getTestPair<T>(id: string, initial: T, channel = new MessageChannel()) {
    const primary = new lib.PrimaryStore(id, writable(initial))
    const replicated = new lib.ReplicatedStore(id, writable(initial))
    primary.attach(channel.port1)
    replicated.attach(channel.port2)
    const cleanup = () => {
        primary.detach(channel.port1)
        replicated.detach(channel.port2)
    }
    return {primary, replicated, cleanup, channel}
}

function assertStream<T>(store: Readable<T>, expected: T[]): Promise<void> {
    return new Promise((resolve) => {
        let i = 0
        const unsubscribe = store.subscribe((value) => {
            assert.equal(value, expected[i++])
            if (i === expected.length) {
                unsubscribe()
                resolve()
            }
        })
    })
}
