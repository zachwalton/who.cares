# iffy.app

https://iffy.app

An express server + UI that uses various inputs (political leaning, time budget, target period, personal experience) to suggest an amount of time that is reasonable to spend researching a given US political topic, based on different categories and weights.

See [./public/METHODOLOGY.md](METHODOLOGY.md) for more details.

## Code quality

All this is pretty much AI generated so while functionally it's ok, the quality is a mess. You have been warned :)

## Running

```bash
npm install
export OPENAI_API_KEY=<your-key>
npm start
```

The server will be running at http://localhost:3000.
