# Checking an action's result

Guard can verify required output values before recording an action as successful.
Declare checks in `beforeAction`, then pass the actual returned output to
`afterAction`. The receipt fixes the expectations before execution.

```js
const before = await memory.beforeAction('import the updated module', {
  tool: 'Bash',
  successChecks: [
    {
      id: 'module-value',
      pointer: '/stdout',
      parseJson: true,
      equals: 'expected value',
    },
  ],
});

// Execute the action only if the Guard decision and host policy permit it.
// result is the actual tool response: { exit_code, stdout, ... }.
const after = memory.afterAction({
  receiptId: before.receipt_id,
  outcome: result.exit_code === 0 ? 'succeeded' : 'failed',
  output: result,
});
```

An exit code of zero with the wrong JSON value in `stdout` records `failed`.
Missing output or invalid JSON prevents a reported success from being accepted
and records `unknown`. An explicitly reported execution failure stays failed.
Passing checks does not promote an unknown execution outcome to success.
Blocked or skipped actions do not run the checks.

Each check has a unique `id`, a JSON Pointer into `output`, and an `equals`
value. Supported expected values are strings, finite numbers, booleans and
`null`. Values are compared without type coercion. An empty pointer selects the
entire output; `/items/0/status` selects a nested array element. Pointer escapes
`~1` and `~0` represent `/` and `~`. Inherited properties and getters do not
supply check values.

With `parseJson: true`, the selected value must be a JSON string containing a
scalar value. It is parsed before comparison. Without that option, a selected
string is compared directly. All declared checks must pass. A known mismatch
takes precedence over another check whose value is unavailable.

Guard accepts 1–16 checks. IDs start with a letter or digit and use letters,
digits, underscores, dots and hyphens, up to 64 characters. Pointers are limited
to 512 characters, expected strings to 4096 characters, and JSON parsing to
65536 characters. Invalid
contracts are rejected before a receipt is created. Check IDs and pointers
must pass the existing secret-redaction checks. Expected values are stored as
SHA-256 fingerprints; this avoids storing their plaintext but is not encryption.
Low-entropy values can be guessed by hashing candidate values.

The returned outcome includes `reported_outcome` and `verification` when checks
were declared. Verification lists the status and reason for each check. The
stored event preserves both the reported outcome and verification result.
Caller-supplied event metadata cannot replace the receipt's verification result.

Within the configured exact-failure window (seven days by default), a failed
check remains active until a later successful action passes the same contract.
A retry that omits checks cannot clear it. Declaring a different contract, or
none, does not hide an existing failure for the same action; the contract only
decides which later success counts as recovery. Checks are identified by their IDs,
pointers, parsing choices and expected values; their declaration order does
not matter. Normal prior-failure acknowledgement and unrelated Guard warnings
still apply.

For REST, send `success_checks` (or `successChecks`) to `POST /v1/guard/before`.
For MCP, pass `success_checks` to `memory_guard_before`. Both accept the same
check objects, including the `parseJson` field. Supply the actual output through
the corresponding Guard-after endpoint. Expectations cannot be replaced in
that call. The receipt-based JavaScript API supports the same behavior.
The older `MemoryController.beforeAction(AgentAction)` interface rejects
`successChecks`; use `Audrey.beforeAction` and `Audrey.afterAction` for verification.

These are caller-defined checks over caller-supplied output. They do not attest
that a tool ran or prove that the checks fully describe the user's goal. Guard
does not run arbitrary verification commands, infer expected values, or generate
application-specific checks. Existing integrations that declare no checks keep
their reported-outcome behavior. Autopilot respects an explicit `unknown`
outcome even when the tool reports exit code zero.
