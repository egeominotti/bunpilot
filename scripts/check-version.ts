import packageJson from '../package.json';
import { VERSION } from '../src/version';

if (VERSION !== packageJson.version) {
  throw new Error(`Version mismatch: src=${VERSION}, package=${packageJson.version}`);
}

const tag = process.argv[2];
if (tag && tag !== `v${VERSION}`) {
  throw new Error(`Release tag ${tag} does not match v${VERSION}`);
}

console.log(`version ${VERSION} is consistent${tag ? ` with tag ${tag}` : ''}`);
