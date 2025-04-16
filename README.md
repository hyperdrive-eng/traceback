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

    <img width="376" alt="image" src="https://github.com/user-attachments/assets/681d10f6-d4c3-4478-9bf4-7790b272a050" />

1. Load demo logs from the repository

    <img width="473" alt="image" src="https://github.com/user-attachments/assets/61f70062-7838-454a-945d-f036d692084b" />

1. Click on a log line

    <img width="555" alt="image" src="https://github.com/user-attachments/assets/27d9d5bc-23ed-44f2-918d-cd810c43e987" />

1. See log in the context of your code

    <img width="1035" alt="image" src="https://github.com/user-attachments/assets/65403c78-abaf-49e2-85c4-9086b2a89d8d" />

1. Click on a parent in the call stack

    <img width="557" alt="image" src="https://github.com/user-attachments/assets/41cc2d2a-df41-43d8-960f-8bf06eb68770" />

1. See parent in the context of your code

    <img width="771" alt="image" src="https://github.com/user-attachments/assets/37e2ab7b-99d0-4c33-a110-3c84b52534fb" />

1. Click on its parent in the call stack

<img width="558" alt="image" src="https://github.com/user-attachments/assets/3d45bc2f-258a-43c9-939b-eb6d9ad76785" />

1. See its parent in the context of your code

    <img width="546" alt="image" src="https://github.com/user-attachments/assets/4584aedb-8c27-4da4-84c4-78b70bab63c2" />
