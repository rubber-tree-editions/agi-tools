import fs from 'fs';
import osPath from 'path';

export interface RawLogic {
  bytecode: Buffer;
  messageBlock: Uint8Array;
  messageOffsets: number[];
}

export interface ResourceRef {
  fileNumber: number;
  offset: number;
}

const AVIS_DURGAN = Buffer.from('Avis Durgan');

const avisDurgan = (b: Uint8Array) => {
  for (let i = 0; i < b.length; i++) {
    b[i] ^= AVIS_DURGAN[i % AVIS_DURGAN.length];
  }
  return b;
}

export class DataStore {
  constructor(readonly rootPath: string) {
  }
  private volCache = new Map<number, Buffer>();
  async getFile(i: number) {
    const cached = this.volCache.get(i);
    if (cached) return cached;
    const result = await fs.promises.readFile(osPath.join(this.rootPath, `vol.${i}`));
    this.volCache.set(i, result);
    return result;
  }
  async getResource({fileNumber, offset}: ResourceRef) {
    const container = await this.getFile(fileNumber);
    if (container.readUInt16BE(offset) !== 0x1234 || container[offset+2] !== fileNumber) {
      console.warn(`invalid (${fileNumber} ${offset}): `+ container.readUInt16BE(offset).toString(16));
    }
    const length = container.readUInt16LE(offset + 3);
    const extracted = container.subarray(offset + 5, offset + 5 + length);
    if (extracted.length !== length) {
      throw new Error(`invalid: expected ${length}, got ${extracted.length} (${fileNumber} ${offset})`);
    }
    return container.subarray(offset + 5, offset + 5 + length);
  }
  private _logicDir?: Promise<Array<ResourceRef | null>>;
  private getLogicDir() {
    return this._logicDir = this._logicDir || (async () => {
      const rawBytes = await fs.promises.readFile(osPath.join(this.rootPath, 'logdir'));
      const logicDir = new Array<ResourceRef | null>(rawBytes.length/3);
      for (let i = 0; i < logicDir.length; i++) {
        const b1 = rawBytes[i*3];
        const b23 = rawBytes.readUInt16BE(i*3 + 1);
        const combo = (b1 << 16) | b23;
        if (combo === 0xffffff) {
          logicDir[i] = null;
        }
        else {
          const fileNumber = combo >>> 20;
          const offset = combo & ((1 << 20)-1);
          logicDir[i] = {fileNumber, offset};
        }
      }
      return logicDir;
    })();
  }
  async getLogic(logicNumber: number): Promise<RawLogic | null> {
    const logicDir = await this.getLogicDir();
    const logicEntry = logicDir[logicNumber];
    if (logicEntry == null) return null;
    const buf = await this.getResource(logicEntry);
    const textOffset = 2 + buf.readUInt16LE(0);
    const textBlock = buf.subarray(textOffset);
    const messageCount = textBlock[0];
    const messageBlock = avisDurgan(Buffer.from(textBlock.subarray(3 + messageCount*2)));
    const messageOffsets = new Array<number>(1 + messageCount);
    messageOffsets[0] = -1;
    for (let i = 1; i < messageOffsets.length; i++) {
      const ptr = textBlock.readUInt16LE(1 + i*2);
      if (ptr === 0) {
        messageOffsets[i] = -1;
      }
      else {
        messageOffsets[i] = ptr - (1 + messageCount)*2;
      }
    }
    return {
      bytecode: buf.subarray(2, textOffset),
      messageBlock,
      messageOffsets,
    };
  }
}
