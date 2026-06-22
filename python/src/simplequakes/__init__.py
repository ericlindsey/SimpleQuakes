"""SimpleQuakes reference implementation.

Pure-Python/NumPy Okada (1985) elastic half-space solutions. This package is
the trusted, double-precision *reference* used to validate the GPU/WebGL port
that powers the interactive web app. It is not shipped to the browser.
"""

from simplequakes import okada85

__all__ = ["okada85"]
