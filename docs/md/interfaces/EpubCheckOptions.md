[**epubcheck-ts**](../README.md)

***

[epubcheck-ts](../globals.md) / EpubCheckOptions

# Interface: EpubCheckOptions

Defined in: types.ts:83

Options for EpubCheck

## Properties

### customMessages?

> `optional` **customMessages**: `Map`\<`string`, [`MessageSeverity`](../type-aliases/MessageSeverity.md)\>

Defined in: types.ts:99

Custom message severity overrides (message ID → severity)

***

### includeInfo?

> `optional` **includeInfo**: `boolean`

Defined in: types.ts:93

Whether to include info messages

***

### includeUsage?

> `optional` **includeUsage**: `boolean`

Defined in: types.ts:91

Whether to include usage messages

***

### locale?

> `optional` **locale**: `string`

Defined in: types.ts:97

Locale for messages (e.g., 'en', 'de', 'fr')

***

### maxErrors?

> `optional` **maxErrors**: `number`

Defined in: types.ts:95

Maximum number of errors before stopping (0 = unlimited)

***

### mode?

> `optional` **mode**: [`ValidationMode`](../type-aliases/ValidationMode.md)

Defined in: types.ts:89

Validation mode for single-file or expanded directory validation

***

### profile?

> `optional` **profile**: [`EPUBProfile`](../type-aliases/EPUBProfile.md)

Defined in: types.ts:87

Validation profile

***

### version?

> `optional` **version**: `"2.0"` \| `"3.0"` \| `"3.1"` \| `"3.2"` \| `"3.3"`

Defined in: types.ts:85

EPUB version to validate against (auto-detected if not specified)
