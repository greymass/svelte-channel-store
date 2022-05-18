/* eslint-disable @typescript-eslint/no-empty-function */
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
        const p2 = getTestPair('test2', 2, {channel: p1.channel})
        defer(p1.cleanup, p2.cleanup)
        p1.primary.set(11)
        p2.primary.set(22)
        await Promise.all([
            assertStream(p1.replicated, [1, 11]),
            assertStream(p2.replicated, [2, 22]),
        ])
    })

    test('transport serialization', async function () {
        let encodeCallCount = 0
        let decodeCallCount = 0
        const p = getTestPair('test', 0, {
            options: {
                encode: (number) => {
                    encodeCallCount++
                    return number == 42 ? 'forty two' : 'boring number'
                },
                decode: (string) => {
                    decodeCallCount++
                    return string === 'forty two' ? 42 : 0
                },
            },
        })
        defer(p.cleanup)
        p.primary.set(42)
        await assertStream(p.replicated, [0, 42])
        p.replicated.set(43232)
        await assertStream(p.primary, [42, 0])
        assert.equal(decodeCallCount, 2)
        assert.equal(encodeCallCount, 3) // 1 extra time for initial value
    })

    test('complex transport serialization', function (done) {
        const options = {
            encode: (number) => {
                return {
                    type: 'number',
                    number,
                    data: new Uint32Array([number]).buffer,
                    checksum: [new Uint32Array([number ^ 42]).buffer],
                }
            },
            decode: (payload) => {
                if (payload.type !== 'number') {
                    throw new Error("Expected 'number' payload")
                }
                const checksum = new Uint32Array(payload.checksum[0])[0]
                const number = new Uint32Array(payload.data)[0]
                if (checksum !== (number ^ 42)) {
                    throw new Error('Checksum mismatch')
                }
                if (payload.number !== number) {
                    throw new Error('Number mismatch')
                }
                return number
            },
        }
        const p = getTestPair('test', 0, {options})
        const ch2 = new MessageChannel()
        const ch3 = new MessageChannel()
        const r2 = new lib.ReplicatedStore('test', writable(0), options)
        const r3 = new lib.ReplicatedStore('test', writable(0), options)
        p.primary.attach(ch2.port1)
        p.primary.attach(ch3.port1)
        r2.attach(ch2.port2)
        r3.attach(ch3.port2)
        defer(p.cleanup, () => {
            p.primary.detach(ch2.port1)
            p.primary.detach(ch3.port1)
            r2.detach(ch2.port2)
            r3.detach(ch3.port2)
        })
        let i = 0
        defer(
            r2.subscribe((value) => {
                switch (i++) {
                    case 0:
                        assert.equal(value, 0)
                        break
                    case 1:
                        assert.equal(value, 100)
                        r3.set(200)
                        break
                    case 2:
                        assert.equal(value, 200)
                        done()
                        break
                    default:
                        done(new Error('Too many values'))
                }
            })
        )
        defer(p.replicated.subscribe(() => {})) // keep store hot so we test transfers to multiple ports
        p.primary.set(100)
    })
})

function getTestPair<T, T2 = any>(
    id: string,
    initial: T,
    extra: {channel?: MessageChannel; options?: lib.ChannelStoreOptions<T, T2>} = {}
) {
    const channel = extra.channel || new MessageChannel()
    const primary = new lib.PrimaryStore<T, T2>(id, writable(initial), extra.options)
    const replicated = new lib.ReplicatedStore<T, T2>(id, writable(initial), extra.options)
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
