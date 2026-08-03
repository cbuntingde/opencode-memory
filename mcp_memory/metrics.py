"""
Metrics and observability for MCP Memory Server.

Tracks operation metrics, health status, and performance indicators.
"""

import logging
import time
from typing import Dict, Any, Optional
from dataclasses import dataclass, field, asdict
from datetime import datetime
from collections import defaultdict


@dataclass
class OperationMetrics:
    """Metrics for a specific operation."""
    operation_name: str
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    total_duration_ms: float = 0.0
    min_duration_ms: float = float('inf')
    max_duration_ms: float = 0.0
    last_error: Optional[str] = None
    last_called: Optional[str] = None

    @property
    def average_duration_ms(self) -> float:
        """Calculate average call duration."""
        if self.successful_calls == 0:
            return 0.0
        return self.total_duration_ms / self.successful_calls

    @property
    def success_rate(self) -> float:
        """Calculate success rate (0.0-1.0)."""
        if self.total_calls == 0:
            return 0.0
        return self.successful_calls / self.total_calls

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            **asdict(self),
            'average_duration_ms': round(self.average_duration_ms, 2),
            'success_rate': round(self.success_rate, 3),
        }


@dataclass
class HealthStatus:
    """System health status."""
    database_connected: bool = False
    database_healthy: bool = False
    embeddings_available: bool = False
    embeddings_loaded: bool = False
    last_health_check: Optional[str] = None
    memory_count: int = 0
    project_count: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)


class MetricsCollector:
    """Collects and tracks system metrics."""

    def __init__(self):
        """Initialize metrics collector."""
        self.operation_metrics: Dict[str, OperationMetrics] = defaultdict(
            lambda: OperationMetrics(operation_name="")
        )
        self.health_status = HealthStatus()
        self.logger = logging.getLogger(__name__)

    def record_operation(self, operation_name: str, duration_ms: float, success: bool, 
                        error: Optional[str] = None):
        """
        Record an operation execution.

        Args:
            operation_name: Name of the operation (e.g., 'add_memory', 'search_memories')
            duration_ms: Duration in milliseconds
            success: Whether operation succeeded
            error: Error message if failed
        """
        if operation_name not in self.operation_metrics:
            self.operation_metrics[operation_name] = OperationMetrics(operation_name=operation_name)

        metrics = self.operation_metrics[operation_name]
        metrics.total_calls += 1
        metrics.total_duration_ms += duration_ms
        metrics.min_duration_ms = min(metrics.min_duration_ms, duration_ms)
        metrics.max_duration_ms = max(metrics.max_duration_ms, duration_ms)
        metrics.last_called = datetime.now().isoformat()

        if success:
            metrics.successful_calls += 1
        else:
            metrics.failed_calls += 1
            if error:
                metrics.last_error = error

        # Log slow operations
        if duration_ms > 1000:
            self.logger.warning(
                f"Slow operation: {operation_name} took {duration_ms:.0f}ms "
                f"(success={success})"
            )

    def get_operation_metrics(self, operation_name: Optional[str] = None) -> Dict[str, Any]:
        """
        Get operation metrics.

        Args:
            operation_name: Specific operation to get metrics for. If None, returns all.

        Returns:
            Dictionary of operation metrics
        """
        if operation_name:
            if operation_name in self.operation_metrics:
                return self.operation_metrics[operation_name].to_dict()
            return {}

        return {
            name: metrics.to_dict()
            for name, metrics in self.operation_metrics.items()
        }

    def update_health_status(self, database_connected: bool = None, database_healthy: bool = None,
                           embeddings_available: bool = None, embeddings_loaded: bool = None,
                           memory_count: int = None, project_count: int = None):
        """
        Update health status.

        Args:
            database_connected: Database connection status
            database_healthy: Database health status
            embeddings_available: Embeddings available
            embeddings_loaded: Embeddings loaded
            memory_count: Total memory count
            project_count: Total project count
        """
        if database_connected is not None:
            self.health_status.database_connected = database_connected
        if database_healthy is not None:
            self.health_status.database_healthy = database_healthy
        if embeddings_available is not None:
            self.health_status.embeddings_available = embeddings_available
        if embeddings_loaded is not None:
            self.health_status.embeddings_loaded = embeddings_loaded
        if memory_count is not None:
            self.health_status.memory_count = memory_count
        if project_count is not None:
            self.health_status.project_count = project_count

        self.health_status.last_health_check = datetime.now().isoformat()

    def get_health_status(self) -> Dict[str, Any]:
        """Get current health status."""
        return self.health_status.to_dict()

    def get_summary(self) -> Dict[str, Any]:
        """
        Get complete metrics summary.

        Returns:
            Dictionary with health, operation metrics, and summary stats
        """
        total_calls = sum(m.total_calls for m in self.operation_metrics.values())
        total_successful = sum(m.successful_calls for m in self.operation_metrics.values())
        total_failed = sum(m.failed_calls for m in self.operation_metrics.values())
        
        avg_duration = 0.0
        if total_successful > 0:
            total_duration = sum(m.total_duration_ms for m in self.operation_metrics.values())
            avg_duration = total_duration / total_successful

        return {
            'health': self.get_health_status(),
            'summary': {
                'total_operations': total_calls,
                'successful_operations': total_successful,
                'failed_operations': total_failed,
                'overall_success_rate': round(total_successful / total_calls, 3) if total_calls > 0 else 0.0,
                'average_operation_duration_ms': round(avg_duration, 2),
                'tracked_operations': len(self.operation_metrics),
            },
            'operations': self.get_operation_metrics(),
        }


# Global metrics collector instance
_metrics_collector: Optional[MetricsCollector] = None


def get_metrics_collector() -> MetricsCollector:
    """Get or create global metrics collector."""
    global _metrics_collector
    if _metrics_collector is None:
        _metrics_collector = MetricsCollector()
    return _metrics_collector


def record_operation(operation_name: str, duration_ms: float, success: bool, 
                    error: Optional[str] = None):
    """
    Record an operation for metrics tracking.

    Args:
        operation_name: Name of operation
        duration_ms: Duration in milliseconds
        success: Whether operation succeeded
        error: Error message if failed
    """
    get_metrics_collector().record_operation(operation_name, duration_ms, success, error)


class OperationTimer:
    """Context manager for timing operations."""

    def __init__(self, operation_name: str):
        """
        Initialize timer.

        Args:
            operation_name: Name of the operation being timed
        """
        self.operation_name = operation_name
        self.start_time: Optional[float] = None
        self.logger = logging.getLogger(__name__)

    def __enter__(self):
        """Start timing."""
        self.start_time = time.time()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Stop timing and record metrics."""
        if self.start_time is None:
            return False

        duration_ms = (time.time() - self.start_time) * 1000
        success = exc_type is None
        error = f"{exc_type.__name__}: {exc_val}" if exc_type else None

        record_operation(self.operation_name, duration_ms, success, error)

        return False  # Don't suppress exceptions
