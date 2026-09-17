import { put, reset, } from './lib/util.mjs'

reset({ content: document.getElementById('content1'), })
put(`Delivered ${location} on ${Date()} to YOUR_IP_ADDRESS`, '<hr/>')
