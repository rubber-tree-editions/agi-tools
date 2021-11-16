
import util from "util";
const { isTypedArray } = util.types;

export const longestCommonSubarray = <T>(array1: ArrayLike<T>, array2: ArrayLike<T>): Array<[offset1: number, offset2: number, length: number]> => {
  if (array2.length > array1.length) {
    return longestCommonSubarray(array2, array1).map(([a, b, c]) => [b, a, c]);
  }
  else if (array2.length === 0) {
    return [];
  }
  else if (array2.length === array1.length) {
    if ((array1 === array2) || (
      isTypedArray(array1)
      && isTypedArray(array2)
      && array1.constructor === array2.constructor
      && Buffer.compare(
        new Uint8Array(array1.buffer, array1.byteOffset, array1.byteLength),
        new Uint8Array(array2.buffer, array2.byteOffset, array2.byteLength)
      ) === 0
    )) {
      return [[0, 0, array1.length]];
    }
  }
  const IndexArray = array1.length < 256 ? Uint8Array
                  : array1.length < 65536 ? Uint16Array
                  : Uint32Array;
  const ROW_LENGTH = array2.length;
  const data = new IndexArray(ROW_LENGTH * 2);
  const prevRow = data.subarray(0, ROW_LENGTH);
  const thisRow = data.subarray(ROW_LENGTH);
  const initNextRow = () => {
    data.copyWithin(0, ROW_LENGTH);
    thisRow.fill(0);
  };
  let maxFoundLength = 0;
  let results: Array<[number, number, number]> = [];

  const firstByte1 = array1[0], firstByte2 = array2[0];
  for (let j = 0; j < array2.length; j++) {
    if (array2[j] === firstByte1) {
      prevRow[j] = 1;
      switch (maxFoundLength) {
        case 0: {
          maxFoundLength = 1;
          results = [[0, j, 1]];
          break;
        }
        case 1: {
          results.push([0, j, 1]);
          break;
        }
      }
    }
  }
  for (let i = 1; i < array1.length; i++) {
    if (array1[i] === firstByte2) {
      thisRow[0] = 1;
      switch (maxFoundLength) {
        case 0: {
          maxFoundLength = 1;
          results = [[i, 0, 1]];
          break;        
        }
        case 1: {
          results.push([i, 0, 1]);
          break;
        }
      }
    }
    for (let j = 1; j < array2.length; j++) {
      if (array1[i] === array2[j]) {
        const length = prevRow[j-1] + 1;
        thisRow[j] = length;
        switch (Math.sign(length - maxFoundLength)) {
          case 0: {
            results.push([i+1-maxFoundLength, j+1-maxFoundLength, maxFoundLength]);
            break;
          }
          case 1: {
            maxFoundLength = length;
            results = [[i+1-maxFoundLength, j+1-maxFoundLength, maxFoundLength]];
          }
        }
      }
    }
    initNextRow();
  }

  return results;
}
