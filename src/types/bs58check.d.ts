declare module 'bs58check' {
    function encode(buffer: Buffer): string;
    function decode(str: string): Buffer;
    export = { encode, decode };
}
