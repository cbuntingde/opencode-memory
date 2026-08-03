"""
Configuration for memory classification system.

This module defines keywords and modifiers used for automatic memory classification
and importance scoring. Can be extended without modifying core logic.
"""

# Keywords that determine memory type
MEMORY_TYPE_KEYWORDS = {
    'error': {
        'keywords': ('error', 'exception', 'failed', 'bug', 'crash', 'traceback', 'stderr', 'warning', 'issue'),
        'base_importance': 0.8,
        'description': 'Error or issue encountered'
    },
    'code': {
        'keywords': ('function', 'class', 'method', 'import', 'def ', 'async ', 'await', 'return', 'variable', 'algorithm'),
        'base_importance': 0.7,
        'description': 'Code snippet or implementation detail'
    },
    'decision': {
        'keywords': ('decided', 'choose', 'approach', 'strategy', 'solution', 'implement', 'architecture', 'design'),
        'base_importance': 0.9,
        'description': 'Architectural or design decision'
    },
    'pattern': {
        'keywords': ('pattern', 'template', 'structure', 'framework', 'convention', 'standard', 'best practice'),
        'base_importance': 0.6,
        'description': 'Code pattern or best practice'
    },
    'conversation': {
        'keywords': (),  # Default fallback
        'base_importance': 0.5,
        'description': 'General conversation'
    }
}

# Keywords that modify importance score
IMPORTANCE_MODIFIERS = {
    'critical': 0.3,      # Very important
    'important': 0.2,     # Significantly increases importance
    'urgent': 0.2,        # Time-sensitive
    'priority': 0.15,     # High priority
    'security': 0.25,     # Security-related (very important)
    'performance': 0.2,   # Performance-critical
    'optimization': 0.15, # Optimization opportunity
    'refactor': 0.1,      # Refactoring task
    'cleanup': 0.05,      # Cleanup/maintenance
    'documentation': 0.1, # Documentation
    'breaking': 0.25,     # Breaking change
    'deprecated': 0.15,   # Deprecation notice
    'todo': 0.1,          # Task reminder
    'fixme': 0.15,        # Fix needed
}

# Content length modifiers
LENGTH_MODIFIERS = {
    (1000, float('inf')): 0.15,  # Long content (>1000 chars)
    (500, 1000): 0.10,            # Medium content (500-1000 chars)
    (50, 500): 0.0,               # Normal content (50-500 chars)
    (0, 50): -0.1,                # Short content (<50 chars)
}

# Minimum and maximum importance values
MIN_IMPORTANCE = 0.1
MAX_IMPORTANCE = 1.0

# Memory types allowed by the system
ALLOWED_MEMORY_TYPES = {
    'working',      # Current task or focus
    'semantic',     # Factual knowledge
    'episodic',     # Event that happened
    'procedural',   # How to do something
    'error',        # Error or bug
    'code',         # Code snippet
    'decision',     # Architectural decision
    'pattern',      # Design pattern
    'conversation', # General conversation
    'environment',  # Environment info
    'commands',     # Command reference
    'tools',        # Tool usage
    'deployment',   # Deployment info
    'testing',      # Testing info
}
