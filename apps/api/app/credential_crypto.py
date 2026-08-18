from base64 import urlsafe_b64encode
from hashlib import sha256

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


class CredentialCryptoError(RuntimeError):
    pass


def _fernet() -> Fernet:
    digest = sha256(settings.credentials_secret.encode("utf-8")).digest()
    return Fernet(urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    if not value:
        return ""
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str | None) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise CredentialCryptoError("平台授权凭据无法解密，请重新授权该账号。") from exc
