import {get} from 'svelte/store'
import type {Subscriber, Unsubscriber, Updater, Writable} from 'svelte/store'

export interface ChannelStore<T> extends Writable<T> {
    /**
     * Attach a port to this store.
     * @param port The port to attach.
     * @param start Thether to start the port automatically, defaults to true.
     */
    attach(port: MessagePort, start?: boolean): void
    /**
     * Detach a port from this store
     * @param port Port to detach
     * @throws Error if port is not attached.
     */
    detach(port: MessagePort): void
}

/**
 * The primary store can be attached to multiple secondary stores via a channel.
 */
export class PrimaryStore<T> implements ChannelStore<T> {
    private ports: Array<{port: MessagePort; handler: any}> = []
    private subscribers = new Set<MessagePort>()
    private wrapped: Writable<T>

    /**
     * Create a new primary store.
     * @param id The id of the store, e.g. 'myStore'.
     * @param store The svelte store to wrap.
     */
    constructor(readonly id: string, store: Writable<T>) {
        this.wrapped = store
    }

    /**
     * Handle message from a port.
     * @internal
     */
    private handleMessage(port: MessagePort, event: MessageEvent<ChannelMessage<T>>) {
        if (event.data.id !== this.id) {
            return
        }
        switch (event.data.type) {
            case 'set':
                this.set(event.data.payload!, port)
                break
            case 'subscribe':
                this.subscribers.add(port)
                port.postMessage({
                    id: this.id,
                    type: 'set',
                    payload: get(this.wrapped),
                })
                break
            case 'unsubscribe':
                this.subscribers.delete(port)
                break
            default:
                throw new Error(`Unknown message type: ${event.data.type}`)
        }
    }

    // ChannelStore conformance

    attach(port: MessagePort, start = true) {
        const handler = (event: MessageEvent) => {
            this.handleMessage(port, event)
        }
        port.addEventListener('message', handler)
        this.ports.push({port, handler})
        if (start) {
            port.start()
        }
    }

    detach(port: MessagePort) {
        const index = this.ports.findIndex((p) => p.port === port)
        if (index === -1) {
            throw new Error('Port not found')
        }
        const {handler} = this.ports[index]
        port.removeEventListener('message', handler)
        this.ports.splice(index, 1)
        this.subscribers.delete(port)
    }

    // Writable conformance

    set(value: T, sender?: MessagePort) {
        this.wrapped.set(value)
        // TODO: serialize hook and transfer if ArrayBuffer
        for (const port of this.subscribers) {
            if (port !== sender) {
                port.postMessage({
                    id: this.id,
                    type: 'set',
                    payload: value,
                })
            }
        }
    }

    update(updater: Updater<T>) {
        this.wrapped.update(updater)
    }

    // Readable conformance

    subscribe(run: Subscriber<T>, invalidate?: (value?: T) => void): Unsubscriber {
        return this.wrapped.subscribe(run, invalidate)
    }
}

export class ReplicatedStore<T> implements ChannelStore<T> {
    private upstream?: {port: MessagePort; handler: any}
    private wrapped: Writable<T>
    private numSubscribers = 0

    /**
     * Create a new replicated store.
     * @param id The id of the store, e.g. 'myStore'.
     * @param store The svelte store to wrap.
     */
    constructor(readonly id: string, store: Writable<T>) {
        this.wrapped = store
    }

    /**
     * Handle message from upstream.
     * @internal
     */
    private handleMessage(event: MessageEvent<ChannelMessage<T>>) {
        if (event.data.id !== this.id) {
            return
        }
        switch (event.data.type) {
            case 'set':
                this.wrapped.set(event.data.payload!)
                break
            case 'subscribe':
            case 'unsubscribe':
                throw new Error('Replicated store got subscription message')
            default:
                throw new Error(`Unknown message type: ${event.data.type}`)
        }
    }

    // ChannelStore conformance

    attach(port: MessagePort, start = true) {
        if (this.upstream) {
            throw new Error('Already attached')
        }
        const handler = (event: MessageEvent) => {
            this.handleMessage(event)
        }
        port.addEventListener('message', handler)
        this.upstream = {port, handler}
        if (start) {
            port.start()
        }
        if (this.numSubscribers > 0) {
            port.postMessage({
                id: this.id,
                type: 'subscribe',
            })
        }
    }

    detach(port: MessagePort) {
        if (this.upstream && this.upstream.port === port) {
            if (this.numSubscribers > 0) {
                this.upstream.port.postMessage({
                    id: this.id,
                    type: 'unsubscribe',
                })
            }
            this.upstream.port.removeEventListener('message', this.upstream.handler)
            this.upstream = undefined
        } else {
            throw new Error('Port not found')
        }
    }

    // Writable conformance

    set(value: T) {
        this.wrapped.set(value)
        if (this.upstream) {
            this.upstream.port.postMessage({
                id: this.id,
                type: 'set',
                payload: value,
            })
        } else {
            // eslint-disable-next-line no-console
            console.warn(
                `ReplicatedStore (${this.id}): set called but not attached, this update will be lost`,
                value
            )
        }
    }

    update(updater: Updater<T>) {
        this.set(updater(get(this.wrapped)))
    }

    // Readable conformance

    subscribe(run: Subscriber<T>, invalidate?: (value?: T) => void): Unsubscriber {
        this.numSubscribers++
        if (this.upstream && this.numSubscribers === 1) {
            this.upstream.port.postMessage({
                id: this.id,
                type: 'subscribe',
            })
        }
        const unsubscribe = this.wrapped.subscribe(run, invalidate)
        return () => {
            this.numSubscribers--
            unsubscribe()
            if (this.numSubscribers === 0 && this.upstream) {
                this.upstream.port.postMessage({
                    id: this.id,
                    type: 'unsubscribe',
                })
            }
        }
    }
}

/**
 * Interface for the messages used to communicate between primary and secondary stores.
 * @internal
 */
interface ChannelMessage<T> {
    id: string
    type: 'set' | 'subscribe' | 'unsubscribe'
    payload?: T
}
