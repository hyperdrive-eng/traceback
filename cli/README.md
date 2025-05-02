# Traceback

A terminal-based AI chat interface built with Textual.

## Features

- Terminal UI for AI chat interactions
- Support for interrupting AI responses mid-generation
- Formatted text and code display

## Installation

### Development Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/traceback.git
cd traceback
```

2. Create and activate a virtual environment:
```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
```

3. Install in development mode:
```bash
pip install -e ".[dev]"
```

4. Launch the application:
```bash
traceback
```

5. (Optional) Install dependencies
```bash
pip install <package-name>
```

6. (Optional) Freeze dependencies for others
```
pip freeze > requirements.txt
```

7. Deactivate environment
```sh
deactivate
```

### User Installation

Install using pipx (recommended):
```bash
pipx install tracebackapp
```

Or using pip:
```bash
pip install tracebackapp
```

## Usage

Launch the application:
```bash
traceback
```

With options:
```bash
traceback --model claude-3-opus  # Specify a model
traceback --debug                # Enable debug mode
```

## Keyboard Shortcuts

- `Ctrl+C` - Quit the application
- `Ctrl+I` - Interrupt the current AI response

## Development

### Code Style

The project uses:
- Black for code formatting
- isort for import sorting
- mypy for type checking
- ruff for linting

Run checks:
```bash
black .
isort .
mypy .
ruff .
```

### Testing

Run tests:
```bash
pytest
```


