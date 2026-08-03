"""
Custom exceptions for MCP Memory Server.
"""


class MemoryException(Exception):
    """Base exception for all MCP Memory errors."""
    pass


class DatabaseException(MemoryException):
    """Exception raised for database-related errors."""
    pass


class EmbeddingException(MemoryException):
    """Exception raised for embedding/semantic search errors."""
    pass


class ConventionException(MemoryException):
    """Exception raised for project convention detection errors."""
    pass


class ValidationException(MemoryException):
    """Exception raised for input validation errors."""
    pass


class SessionException(MemoryException):
    """Exception raised for session management errors."""
    pass
