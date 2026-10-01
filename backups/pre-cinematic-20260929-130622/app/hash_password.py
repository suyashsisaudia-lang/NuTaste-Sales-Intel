"""
Generate a bcrypt hash for SITE_PASSWORD_HASH or ADMIN_PASSWORD_HASH.

    python -m app.hash_password

The password is read with the terminal echo off and is never printed; only
the hash is shown. Paste the hash into your host's environment settings.
"""
import getpass
import secrets

import bcrypt

if __name__ == "__main__":
    pw = getpass.getpass("Password to hash: ")
    again = getpass.getpass("Repeat: ")
    if pw != again:
        raise SystemExit("Passwords do not match.")
    if len(pw) < 12:
        print("Warning: shorter than 12 characters. A longer passphrase is strongly recommended.")
    print("\nHash (store as SITE_PASSWORD_HASH or ADMIN_PASSWORD_HASH):")
    print(bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=12)).decode())
    print("\nA fresh SECRET_KEY, if you need one:")
    print(secrets.token_urlsafe(48))
