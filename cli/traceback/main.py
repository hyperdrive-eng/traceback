"""Main entry point for the Traceback CLI."""

import typer
from typing import Optional

from traceback.tui.app import TracebackApp

app = typer.Typer(
    name="traceback",
    help="A terminal-based AI chat interface",
    add_completion=False,
)


@app.command()
def main(
    debug: bool = typer.Option(
        False,
        "--debug",
        "-d",
        help="Enable debug mode",
    ),
    model: Optional[str] = typer.Option(
        None,
        "--model",
        "-m",
        help="Specify which AI model to use",
    ),
) -> None:
    """Launch the Traceback TUI."""
    traceback_app = TracebackApp()
    traceback_app.run()


if __name__ == "__main__":
    app()