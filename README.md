# TraceBack

A VS Code extension that brings telemetry data (traces, logs, and metrics) into your code.

## Demo

## Quick Start

1. [Install extension](https://marketplace.visualstudio.com/items/?itemName=hyperdrive-eng.traceback)

1. Loads logs

    <img width="750" alt="choose data sources in settings" src="https://github.com/user-attachments/assets/94e2e749-0f66-4b9d-8bc9-40f71795022d" />

1. Debug your code

    <img width="750" alt="select log and debug code" src="https://github.com/user-attachments/assets/9e5c942c-6d40-48ac-8d14-d94ac49c4f6c">

## Features

- Visualize the likely call stack given a set of logs
- Go to the line of code that emitted a log
- View the logs that were emitted in a given call stack

## Usage

1. Open settings

   <img width="550" alt="open settings with command palette" src="https://github.com/user-attachments/assets/a25c776d-adc7-4f57-9f69-5c1ec2ff9cc0">

1. Import logs (copy/paste, import from file, import from web, import from Axiom.co)

1. Select a repository

1. Select a log

1. Select a parent


## Example 

1. Clone this demo repository: [`hyperdrive-eng/playground`](https://github.com/hyperdrive-eng/playground)

    ```sh
    git clone https://github.com/hyperdrive-eng/playground.git
    ```

1. Select the repository in the extension

1. Load demo logs from the repository

1. Click on a log line

1. Click on a parent