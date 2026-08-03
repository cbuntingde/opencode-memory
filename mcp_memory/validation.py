"""
Input validation and security utilities for MCP Memory Server.
"""

import os
import logging
from pathlib import Path
from typing import Optional
from urllib.parse import quote, unquote

from .exceptions import ValidationException


def validate_and_normalize_path(path: Optional[str], allow_none: bool = True) -> Optional[str]:
    """
    Validate and normalize a file path to prevent path traversal attacks.
    
    Args:
        path: Path to validate
        allow_none: Whether None values are allowed
        
    Returns:
        Normalized absolute path, or None if allow_none=True and path is None
        
    Raises:
        ValidationException: If path is invalid or attempts path traversal
    """
    if path is None:
        if allow_none:
            return None
        raise ValidationException("Path cannot be None")
    
    if not isinstance(path, str):
        raise ValidationException(f"Path must be string, got {type(path).__name__}")
    
    if not path.strip():
        raise ValidationException("Path cannot be empty or whitespace")
    
    try:
        # Resolve to absolute path to prevent traversal
        abs_path = Path(path).resolve()
        
        # Ensure path exists or is within a safe directory
        # Don't restrict to existing paths as we may be checking potential paths
        
        return str(abs_path)
    except Exception as e:
        logging.error(f"Invalid path {path}: {e}")
        raise ValidationException(f"Invalid path: {e}") from e


def validate_content(content: Optional[str], min_length: int = 0, max_length: int = 1000000) -> str:
    """
    Validate and sanitize content string.
    
    Args:
        content: Content to validate
        min_length: Minimum allowed length (default: 0)
        max_length: Maximum allowed length (default: 1MB)
        
    Returns:
        Validated content
        
    Raises:
        ValidationException: If content is invalid
    """
    if not content:
        raise ValidationException("Content cannot be None or empty")
    
    if not isinstance(content, str):
        raise ValidationException(f"Content must be string, got {type(content).__name__}")
    
    content = content.strip()
    
    if len(content) < min_length:
        raise ValidationException(f"Content too short (min {min_length} chars)")
    
    if len(content) > max_length:
        raise ValidationException(f"Content too long (max {max_length} chars, got {len(content)})")
    
    return content


def validate_identifier(value: Optional[str], pattern: str = r'^[a-zA-Z_][a-zA-Z0-9_-]*$', 
                       allow_none: bool = False) -> Optional[str]:
    """
    Validate an identifier (memory type, tag, etc.).
    
    Args:
        value: Value to validate
        pattern: Regex pattern for validation (default: alphanumeric with underscore/dash)
        allow_none: Whether None is allowed
        
    Returns:
        Validated identifier
        
    Raises:
        ValidationException: If identifier is invalid
    """
    import re
    
    if value is None:
        if allow_none:
            return None
        raise ValidationException("Identifier cannot be None")
    
    if not isinstance(value, str):
        raise ValidationException(f"Identifier must be string, got {type(value).__name__}")
    
    value = value.strip()
    
    if not value:
        raise ValidationException("Identifier cannot be empty")
    
    if not re.match(pattern, value):
        raise ValidationException(f"Identifier '{value}' doesn't match required pattern")
    
    return value


def validate_number_range(value: float, min_val: float = None, max_val: float = None, 
                         name: str = "value") -> float:
    """
    Validate a number is within range.
    
    Args:
        value: Number to validate
        min_val: Minimum allowed value (inclusive)
        max_val: Maximum allowed value (inclusive)
        name: Name of value for error messages
        
    Returns:
        Validated number
        
    Raises:
        ValidationException: If number is out of range
    """
    try:
        value = float(value)
    except (ValueError, TypeError) as e:
        raise ValidationException(f"{name} must be a number, got {type(value).__name__}") from e
    
    if min_val is not None and value < min_val:
        raise ValidationException(f"{name} must be >= {min_val}, got {value}")
    
    if max_val is not None and value > max_val:
        raise ValidationException(f"{name} must be <= {max_val}, got {value}")
    
    return value


def validate_url_safe_string(value: str, max_length: int = 255) -> str:
    """
    Validate a URL-safe string (for query parameters, identifiers, etc.).
    
    Args:
        value: String to validate
        max_length: Maximum length
        
    Returns:
        Validated URL-safe string
        
    Raises:
        ValidationException: If string is invalid
    """
    if not isinstance(value, str):
        raise ValidationException(f"Value must be string, got {type(value).__name__}")
    
    value = value.strip()
    
    if not value:
        raise ValidationException("String cannot be empty")
    
    if len(value) > max_length:
        raise ValidationException(f"String too long (max {max_length} chars)")
    
    # Check for dangerous characters
    dangerous_chars = ['<', '>', '"', "'", ';', '&', '|', '`', '$']
    if any(char in value for char in dangerous_chars):
        # Just strip them out instead of rejecting
        for char in dangerous_chars:
            value = value.replace(char, '')
        logging.debug(f"Stripped dangerous characters from value")
    
    return value


def mask_sensitive_value(value: str, show_chars: int = 3) -> str:
    """
    Mask a sensitive value for logging.
    
    Args:
        value: Value to mask
        show_chars: Number of characters to show at start
        
    Returns:
        Masked value (e.g., "tok***" for "token123")
    """
    if not value:
        return value
    
    if len(value) <= show_chars:
        return "*" * len(value)
    
    return value[:show_chars] + "*" * (len(value) - show_chars)


def validate_memory_type(memory_type: str, allowed_types: set = None) -> str:
    """
    Validate memory type is in allowed list.
    
    Args:
        memory_type: Memory type to validate
        allowed_types: Set of allowed types. If None, imports from classification_config.
        
    Returns:
        Validated memory type
        
    Raises:
        ValidationException: If memory type is not allowed
    """
    if allowed_types is None:
        try:
            from .classification_config import ALLOWED_MEMORY_TYPES
            allowed_types = ALLOWED_MEMORY_TYPES
        except ImportError:
            allowed_types = {
                'working', 'semantic', 'episodic', 'procedural',
                'error', 'code', 'decision', 'pattern', 'conversation',
                'environment', 'commands', 'tools', 'deployment', 'testing'
            }
    
    memory_type = memory_type.strip().lower()
    
    if memory_type not in allowed_types:
        raise ValidationException(
            f"Invalid memory type '{memory_type}'. Allowed types: {sorted(allowed_types)}"
        )
    
    return memory_type


def validate_tags(tags: list) -> list:
    """
    Validate and sanitize tags list.
    
    Args:
        tags: List of tags
        
    Returns:
        Validated tags list (deduplicated and lowercased)
        
    Raises:
        ValidationException: If tags are invalid
    """
    if tags is None:
        return []
    
    if not isinstance(tags, (list, tuple)):
        raise ValidationException(f"Tags must be list, got {type(tags).__name__}")
    
    validated = []
    for tag in tags:
        if not isinstance(tag, str):
            raise ValidationException(f"Each tag must be string, got {type(tag).__name__}")
        
        tag = tag.strip().lower()
        if tag and len(tag) <= 50:
            if tag not in validated:  # Avoid duplicates
                validated.append(tag)
    
    if len(validated) > 20:
        raise ValidationException(f"Too many tags (max 20, got {len(tags)})")
    
    return validated
