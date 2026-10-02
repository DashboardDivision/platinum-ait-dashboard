# Starter password risk note

The spec requires the recruit's phone number as the first password. Phone numbers are not secret, so anyone who knows a recruit's email and phone could sign in before the recruit does.

What limits it:
- The phone password works only until first sign-in, which forces a new password. The new password can't be the phone number or all digits.
- Sign-in is rate-limited per IP, and every login is recorded.
- There's no public sign-up; accounts exist only for Twenty records.
- A fresh account has no sensitive data beyond the recruit's own name and progress.
- Admins can see "never logged in" and send a reset link or a one-time password at any time.

Remaining risk: a window between account creation and the recruit's first sign-in. Shortening it (for example, expiring unused starter passwords after 14 days) is a one-line setting change if Platinum wants it.
