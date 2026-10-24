from abc import ABC, abstractmethod

from .utils.money import format_currency


class Exporter(ABC):
    """Base class for report exporters."""

    @abstractmethod
    def export(self, rows: list) -> bytes: ...
