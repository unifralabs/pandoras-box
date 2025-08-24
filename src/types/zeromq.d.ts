declare module "zeromq" {
  export class Subscriber {
    connect(endpoint: string): void;
    subscribe(topic: string): void;
    /** Async iterator yielding [topic, message] pairs */
    [Symbol.asyncIterator](): AsyncIterableIterator<[Buffer, Buffer]>;
  }
}
