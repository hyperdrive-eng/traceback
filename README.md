# TraceBack

A VS Code extension that brings telemetry data (traces, logs, and metrics) into your code.

## Demo

## Quick Start

1. [Install extension](https://marketplace.visualstudio.com/items/?itemName=hyperdrive-eng.traceback)

1. Open settings

   <img width="550" alt="open settings with command palette" src="https://github.com/user-attachments/assets/a25c776d-adc7-4f57-9f69-5c1ec2ff9cc0">

1. Loads logs

    <img width="750" alt="choose data sources in settings" src="https://github.com/user-attachments/assets/94e2e749-0f66-4b9d-8bc9-40f71795022d" />

1. Debug your code

    <img width="750" alt="select log and debug code" src="https://github.com/user-attachments/assets/9e5c942c-6d40-48ac-8d14-d94ac49c4f6c">


## Features

- Go to line of code associated with a log
- Go to parent
- See runtime state in your editor

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
