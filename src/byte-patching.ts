
import { longestCommonSubarray } from "./lcs";

export type patch_t = ['add-byte' | 'add-short' | 'insert-byte' | 'insert-short' | 'skip' | 'copy', number] | ['insert' | 'overwrite', Uint8Array] | ['copy-rest'];

const splitPatch = (fromBC: Uint8Array, toBC: Uint8Array, changes: Array<patch_t>) => {
  if (fromBC.length === 0) {
    switch (toBC.length) {
      case 0: {
        return;
      }
      case 1: {
        changes.push(['insert-byte', toBC[0]]);
        return;
      }
      case 2: {
        changes.push(['insert-short', toBC[0] | (toBC[1] << 8)])
        return;
      }
      default: {
        changes.push(['insert', new Uint8Array(toBC)]);
        return;
      }
    }
  }
  else if (toBC.length === 0) {
    changes.push(['skip', fromBC.length]);
    return;
  }
  const longest = longestCommonSubarray(fromBC, toBC);
  if (longest.length === 0) {
    if (toBC.length >= fromBC.length) {
      if (toBC.length === fromBC.length) switch (toBC.length) {
        case 1: {
          changes.push(['add-byte', toBC[0] - fromBC[0]]);
          return;
        }
        case 2: {
          changes.push(['add-short', (toBC[0] | (toBC[1] << 8)) - (fromBC[0] | (fromBC[1] << 8))]);
          return;
        }
      }
      changes.push(['overwrite', new Uint8Array(toBC)]);
      if (toBC.length > fromBC.length) {
        changes.push(['skip', toBC.length - fromBC.length]);
      }
    }
    else {
      switch (toBC.length) {
        case 1: {
          changes.push(['insert-byte', toBC[0]]);
          break;
        }
        case 2: {
          changes.push(['insert-short', toBC[0] | (toBC[1]) << 8]);
          break;
        }
        default: {
          changes.push(['insert', new Uint8Array(toBC)]);
          break;
        }
      }
      changes.push(['skip', fromBC.length]);
    }
    return;
  }

  splitPatch(
    fromBC.subarray(0, longest[0][0]),
    toBC.subarray(0, longest[0][1]),
    changes,
  );

  changes.push(['copy', longest[0][2]]);

  splitPatch(
    fromBC.subarray(longest[0][0] + longest[0][2]),
    toBC.subarray(longest[0][1] + longest[0][2]),
    changes,
  );
};

export const makePatch = (fromBC: Uint8Array, toBC: Uint8Array): Array<patch_t> => {
  if (fromBC.length === toBC.length && Buffer.compare(fromBC, toBC) === 0) {
    return [['copy-rest']];
  }
  const changes = new Array<patch_t>();
  let i = 0;
  while (fromBC[i] === toBC[i]) {
    i++;
  }
  let j = 0;
  while (fromBC[fromBC.length - (j + 1)] === toBC[toBC.length - (j + 1)]) {
    j++;
  }
  fromBC = fromBC.subarray(i, fromBC.length - j);
  toBC = toBC.subarray(i, toBC.length - j);
  if (i !== 0) {
    changes.push(['copy', i]);
  }
  splitPatch(fromBC, toBC, changes);
  if (j !== 0) {
    changes.push(['copy-rest']);
  }
  return changes;
}
