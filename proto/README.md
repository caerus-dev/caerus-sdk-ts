# The contract

`sre_service.proto` is a **copy**. The original lives in `caerus-back`, at
`data-plane-service/src/main/proto/sre_service.proto`, and that is the one the server
is built from. This copy exists only so the SDK can be generated.

## Why a copy

While the SDK lived inside `caerus-back` it read the contract straight from
`data-plane-service`, so it could not drift. That stopped being possible when the SDK
moved here: `caerus-back` is private and this repository is public, and a public
repository nobody can build is not much use.

The copy is the price of that. It is byte-identical to the original, so the two can be
compared with a checksum.

## Where this copy came from

| | |
|---|---|
| Repository | `caerus-dev/caerus-back` |
| Path | `data-plane-service/src/main/proto/sre_service.proto` |
| Commit | `21ba0591e623917b994fcb9f48b8f896183adcc3` |
| SHA-256 | `85a6f376d22ee15a7ac64959eec3410bb1b10bcc1596e9bd7d2e4a8288b753be` |

> The repository's `.gitattributes` marks this file `-text` so git never rewrites its line
> endings. Without that, a copy taken on Windows comes back with CRLF, the checksums stop
> matching, and the check below reports drift on a file that is in fact identical. That
> happened once already — an alarm that cries wolf is worse than no alarm.

## Checking it is still current

With a checkout of `caerus-back` alongside this one:

```bash
sha256sum proto/sre_service.proto
sha256sum ../caerus-back/data-plane-service/src/main/proto/sre_service.proto
```

Same hash, nothing to do. Different, the contract moved and this copy is stale.

## Refreshing it

Copy the file over, run `npm run generate`, and let the type checker find what broke.
Then update the commit and the checksum in the table above — a table that says one thing
while the file says another is worse than no table.

The SDK is versioned independently of the server, so a contract change means deciding
what it does to the public API here: a new optional field is a minor, a changed
signature is a breaking change.

## A warning

The build cannot tell you this copy is stale. It generates the client from whatever is
in this directory and type-checks against that, which passes just as happily against an
old contract as a current one. What catches the drift is running the SDK against a real
server, or the check above.
