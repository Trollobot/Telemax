declare module 'lz4js' {
  export function compressBound(inputLength: number): number;
  export function decompressBlock(
    input: Uint8Array,
    output: Uint8Array,
    startIdx: number,
    length: number,
    outputStartIdx: number,
  ): number;
  export function compressBlock(
    input: Uint8Array,
    output: Uint8Array,
    startIdx: number,
    length: number,
    hashTable: Int32Array,
  ): number;
}
