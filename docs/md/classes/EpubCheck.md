[**epubcheck-ts**](../README.md)

***

[epubcheck-ts](../globals.md) / EpubCheck

# Class: EpubCheck

Defined in: checker.ts:98

Main EPUB validation class

## Example

```typescript
import { EpubCheck } from 'epubcheck-ts';

// Validate from a Uint8Array (works in Node.js and browsers)
const result = await EpubCheck.validate(epubData);

if (result.valid) {
  console.log('EPUB is valid!');
} else {
  console.log(`Found ${result.errorCount} errors`);
  for (const msg of result.messages) {
    console.log(`${msg.severity}: ${msg.message}`);
  }
}
```

## Constructors

### Constructor

> **new EpubCheck**(`options?`): `EpubCheck`

Defined in: checker.ts:104

Create a new EpubCheck instance with custom options

#### Parameters

##### options?

[`EpubCheckOptions`](../interfaces/EpubCheckOptions.md) = `{}`

#### Returns

`EpubCheck`

## Accessors

### version

#### Get Signature

> **get** **version**(): `"2.0"` \| `"3.0"` \| `"3.1"` \| `"3.2"` \| `"3.3"`

Defined in: checker.ts:361

Get the current EPUB version being validated against

##### Returns

`"2.0"` \| `"3.0"` \| `"3.1"` \| `"3.2"` \| `"3.3"`

## Methods

### addMessage()

> `protected` **addMessage**(`messages`, `message`): `void`

Defined in: checker.ts:627

Add a validation message to the context

#### Parameters

##### messages

[`ValidationMessage`](../interfaces/ValidationMessage.md)[]

##### message

[`ValidationMessage`](../interfaces/ValidationMessage.md)

#### Returns

`void`

***

### check()

> **check**(`data`, `filename?`): `Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Defined in: checker.ts:115

Validate an EPUB file

#### Parameters

##### data

`Uint8Array`

The EPUB file as a Uint8Array

##### filename?

`string`

Optional filename, used for file-extension checks (PKG-016/017/024)

#### Returns

`Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Validation result

***

### checkExpanded()

> **checkExpanded**(`files`): `Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Defined in: checker.ts:173

Validate an expanded EPUB directory (pre-read file map)

#### Parameters

##### files

`Map`\<`string`, `Uint8Array`\<`ArrayBufferLike`\>\>

Map of relative file paths to their content

#### Returns

`Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Validation result

***

### checkSingleFile()

> **checkSingleFile**(`data`, `filename`): `Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Defined in: checker.ts:235

Validate a single file (OPF, XHTML, etc.) without a full EPUB container

#### Parameters

##### data

`Uint8Array`

The file content

##### filename

`string`

The filename (used for path in messages)

#### Returns

`Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Validation result

***

### validate()

> `static` **validate**(`data`, `options?`, `filename?`): `Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Defined in: checker.ts:326

Static method to validate an EPUB file with default options

#### Parameters

##### data

`Uint8Array`

The EPUB file as a Uint8Array

##### options?

[`EpubCheckOptions`](../interfaces/EpubCheckOptions.md) = `{}`

Optional validation options

##### filename?

`string`

Optional filename, used for file-extension checks

#### Returns

`Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Validation result

***

### validateExpanded()

> `static` **validateExpanded**(`files`, `options?`): `Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Defined in: checker.ts:338

Static method to validate an expanded EPUB (pre-read file map)

#### Parameters

##### files

`Map`\<`string`, `Uint8Array`\<`ArrayBufferLike`\>\>

##### options?

[`EpubCheckOptions`](../interfaces/EpubCheckOptions.md) = `{}`

#### Returns

`Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

***

### validateSingleFile()

> `static` **validateSingleFile**(`data`, `filename`, `options?`): `Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>

Defined in: checker.ts:349

Static method to validate a single file

#### Parameters

##### data

`Uint8Array`

##### filename

`string`

##### options?

[`EpubCheckOptions`](../interfaces/EpubCheckOptions.md) = `{}`

#### Returns

`Promise`\<[`EpubCheckResult`](../interfaces/EpubCheckResult.md)\>
