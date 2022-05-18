import {get} from 'svelte/store'
import type {Subscriber, Unsubscriber, Updater, Writable} from 'svelte/store'

export interface ChannelStore<T> extends Writable<T> {
    /**
     * Attach a port to this store.
     * @param port The port to attach.
     * @param start Whether to start the port automatically, defaults to true.
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
 * Options for creating a channel store.
 */
export interface ChannelStoreOptions<StoreType, TransferType = StoreType> {
    /** Encode value to be sent over channel, if returned value has `Transferable` values they will be transferred. */
    encode?: (value: StoreType) => TransferType
    /** Decode value received from channel. */
    decode?: (value: TransferType) => StoreType
}

/**
 * Base class for channel stores.
 * @internal
 */
abstract class BaseStore<StoreType, TransferType = StoreType> {
    /**
     * Create a new channel store.
     * @param id The id of the store, e.g. 'myStore'.
     * @param wrapped The svelte store to wrap.
     * @param options Store options.
     */
    constructor(
        protected readonly id: string,
        protected readonly wrapped: Writable<StoreType>,
        protected readonly options: ChannelStoreOptions<StoreType, TransferType> = {}
    ) {}

    protected decodePayload(payload: TransferType): StoreType {
        return this.options.decode ? this.options.decode(payload) : (payload as any)
    }

    protected encodePayload(value: StoreType): TransferType {
        return this.options.encode ? this.options.encode(value) : (value as any)
    }

    protected sendPayload(payload: TransferType, ports: MessagePort[]) {
        if (ports.length === 0) {
            return
        }
        const transfer = this.options.encode ? getTransferables(payload) : []
        for (let i = 0; i < ports.length; i++) {
            // make sure to only transfer to the last if we have multiple ports
            ports[i].postMessage(
                {id: this.id, type: 'set', payload},
                i == ports.length - 1 ? transfer : []
            )
        }
    }
}

/**
 * The primary store can be attached to multiple secondary stores via a channel.
 */
export class PrimaryStore<StoreType, TransferType = StoreType>
    extends BaseStore<StoreType, TransferType>
    implements ChannelStore<StoreType>
{
    private ports: Array<{port: MessagePort; handler: any}> = []
    private subscribers = new Set<MessagePort>()

    /**
     * Handle message from a port.
     * @internal
     */
    private handleMessage(port: MessagePort, event: MessageEvent<ChannelMessage<TransferType>>) {
        if (event.data.id !== this.id) {
            return
        }
        switch (event.data.type) {
            case 'set': {
                const payload = event.data.payload!
                const value = this.decodePayload(payload)
                this.wrapped.set(value)
                const ports = Array.from(this.subscribers).filter((p) => p !== port)
                this.sendPayload(payload, ports)
                break
            }
            case 'subscribe': {
                const value = get(this.wrapped)
                const payload = this.encodePayload(value)
                this.subscribers.add(port)
                this.sendPayload(payload, [port])
                break
            }
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

    set(value: StoreType) {
        this.wrapped.set(value)
        const payload = this.encodePayload(value)
        const ports = Array.from(this.subscribers)
        this.sendPayload(payload, ports)
    }

    update(updater: Updater<StoreType>) {
        this.wrapped.update(updater)
    }

    // Readable conformance

    subscribe(run: Subscriber<StoreType>, invalidate?: (value?: StoreType) => void): Unsubscriber {
        return this.wrapped.subscribe(run, invalidate)
    }
}

export class ReplicatedStore<StoreType, TransferType = StoreType>
    extends BaseStore<StoreType, TransferType>
    implements ChannelStore<StoreType>
{
    private upstream?: {port: MessagePort; handler: any}
    private numSubscribers = 0

    /**
     * Handle message from upstream.
     * @internal
     */
    private handleMessage(event: MessageEvent<ChannelMessage<TransferType>>) {
        if (event.data.id !== this.id) {
            return
        }
        switch (event.data.type) {
            case 'set': {
                const payload = event.data.payload!
                const value = this.decodePayload(payload)
                this.wrapped.set(value)
                break
            }
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

    set(value: StoreType) {
        this.wrapped.set(value)
        if (this.upstream) {
            const payload = this.encodePayload(value)
            this.sendPayload(payload, [this.upstream.port])
        } else {
            // eslint-disable-next-line no-console
            console.warn(
                `ReplicatedStore (${this.id}): set called but not attached, this update will be lost`,
                value
            )
        }
    }

    update(updater: Updater<StoreType>) {
        this.set(updater(get(this.wrapped)))
    }

    // Readable conformance

    subscribe(run: Subscriber<StoreType>, invalidate?: (value?: StoreType) => void): Unsubscriber {
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

/**
 * Get transferable data from given value.
 * @param value Object to find the transferable values in.
 * @returns Array of values that are transferable.
 * @internal
 */
function getTransferables(value: any): Transferable[] {
    const rv: Transferable[] = []
    if (value instanceof ArrayBuffer) {
        rv.push(value)
    } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            rv.push(...getTransferables(value[i]))
        }
    } else if (value && typeof value === 'object') {
        for (const key in value) {
            rv.push(...getTransferables(value[key]))
        }
    }
    return rv
}
