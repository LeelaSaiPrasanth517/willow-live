export class Metrics{constructor(){this.counters=new Map();}inc(name,value=1){this.counters.set(name,(this.counters.get(name)||0)+value);}snapshot(){return Object.fromEntries(this.counters);}}
