# TraceBack

A VS Code extension that brings telemetry data (traces, logs, and metrics) into your code.

## Get started

1. Install TraceBack extension
    1. [Download](https://github.com/hyperdrive-eng/traceback/releases) latest `.vsix` 
    1. Install VSIX

        <img src="https://github.com/user-attachments/assets/1b219565-cf72-4c4a-85a7-659796779803">

1. Open TraceBack settings

   <img src="https://github.com/user-attachments/assets/a25c776d-adc7-4f57-9f69-5c1ec2ff9cc0">

1. Choose a data source (local file, public URL, copy/paste, Axiom.co)

    <img width="1053" alt="image" src="https://github.com/user-attachments/assets/94e2e749-0f66-4b9d-8bc9-40f71795022d" />

1. Load and select a log from the sidebar

    <img src="https://github.com/user-attachments/assets/9e5c942c-6d40-48ac-8d14-d94ac49c4f6c">


## Features

- Click on any telemetry entry to highlight the corresponding line of code
- View variable values next to their declarations
- Navigate code execution by clicking on telemetry entries


## Development

### Setup

```sh
# Install dependencies
npm install

# Compile the extension
npm run compile

# Package the extension
npm run package
```

### Run Extension

1. Build extension

   ```sh
   npm install
   npm run compile
   ```

2. Open directory in VS Code or Cursor

   ```sh
   cursor .
   # or
   code .
   ```

3. Launch extension

   1. Press F5 to open a new window with your extension loaded
   2. If you make changes to your extension, restart the extension development host
