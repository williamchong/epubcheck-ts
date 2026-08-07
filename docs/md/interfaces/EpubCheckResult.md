[**epubcheck-ts**](../README.md)

***

[epubcheck-ts](../globals.md) / EpubCheckResult

# Interface: EpubCheckResult

Defined in: types.ts:59

Result of EPUB validation

## Properties

### elapsedMs

> **elapsedMs**: `number`

Defined in: types.ts:77

Time taken for validation in milliseconds

***

### errorCount

> **errorCount**: `number`

Defined in: types.ts:67

Count of errors

***

### fatalCount

> **fatalCount**: `number`

Defined in: types.ts:65

Count of fatal errors

***

### infoCount

> **infoCount**: `number`

Defined in: types.ts:71

Count of info messages

***

### messages

> **messages**: [`ValidationMessage`](ValidationMessage.md)[]

Defined in: types.ts:63

All validation messages

***

### usageCount

> **usageCount**: `number`

Defined in: types.ts:73

Count of usage messages

***

### valid

> **valid**: `boolean`

Defined in: types.ts:61

Whether the EPUB is valid (no errors or fatal errors)

***

### version?

> `optional` **version**: `"2.0"` \| `"3.0"` \| `"3.1"` \| `"3.2"` \| `"3.3"`

Defined in: types.ts:75

Detected EPUB version

***

### warningCount

> **warningCount**: `number`

Defined in: types.ts:69

Count of warnings
