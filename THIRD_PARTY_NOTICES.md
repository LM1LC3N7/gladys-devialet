# Third-party notices

This integration ports to JavaScript the logic of the following project: the
IP control endpoints of the Devialet speakers (`/ipcontrol/v1/...`), the source
names, and the way the optical inputs of the two speakers of a stereo pair are
told apart when listing, reading and selecting a source
(`src/devialet/client.js`, `src/devialet/inputs.js`). Nothing of it is
installed at runtime; its notice is reproduced below.

## devialet 1.5.7

<https://github.com/fwestenberg/devialet> (the library behind the Home
Assistant Devialet integration)

```
MIT License

Copyright (c) 2022 fwestenberg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, Devialet integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/devialet>
(Apache License 2.0): only consulted, no code copied. The mDNS service type
it browses (`_devialet-http._tcp`) and its use of the serial number as the
identity of a speaker are reused as facts.

## LM1LC3N7/gladys-panasonic-viera and LM1LC3N7/gladys-denon-avr

The structure of the app, the `/data` store and the handler wiring follow
integrations of the same author, under the Apache License 2.0 of this
repository.
