# Error Messages

Every error names what failed, why it matters, how to fix it, and the values involved.

- "error: Invalid" → "Cannot use []Type as comptime value. Use: const x: []const T = &[_]T{a, b}"
- "Connection failed" → "SSH_AUTH_FAILED: Public key rejected by 10.0.1.50. Check ~/.ssh/id_rsa perms (0600)"
- "Parse error" → "JSON parse error line 42 col 15: Expected '}' found ','. Missing brace at line 38."
