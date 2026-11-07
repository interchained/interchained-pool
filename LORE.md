# LORE

## The chain with three engines

Interchained was never meant to be carried by one kind of machine.

From the beginning the design said three engines, three roads:

- SHA256, the iron. The ASICs, the foundries, the heavy hammer.
- Yespower, the people. The ordinary CPU in the ordinary house.
- Ethash, the fire. The GPU rigs, burning bright and fast.

Three kinds of miner.
Three kinds of work.
One chain, one history, one ledger of who proved what.

That was the promise.
For a while, it was only a promise.

## The stall

A chain lives block by block.
When the blocks stop, the chain does not die loudly.
It just stops, and the silence gets longer.

Interchained stalled for four days.

Not because the miners had gone.
Not because the people had stopped caring.
The chain stalled because one engine ruled it.

The first engine held the only road.
The difficulty of the chain was paced to its stride alone.
The other engines had no track of their own to run on,
no difficulty fitted to their weight,
no real way to push the chain forward when the first engine slowed.

CPU miners could hash until their fans sang
and still never realistically move the chain.
GPU miners stood ready with nowhere to stand.
So when SHA256 stalled, everything stalled.
Four days of silence at the top of the chain,
with the tip sitting at block 913981
and the next block owed to no one who could pay it.

That is the lesson the chain taught, the hard way:
a chain with one road is hostage to one kind of machine.

## The answer

The answer was not a new engine.
The answer was to give every engine its own road.

Tri-PoW, made real:

- Each algorithm keeps its own difficulty,
  paced to its own miners, answering to its own hashrate.
- Each algorithm still feeds the same chain,
  the same history, the same single line of blocks.

SHA256 the iron, on its own track at last.
Yespower the people, on a road a CPU can actually travel.
Ethash the fire, with ground fitted to its stride.

If the iron slows, the people can still carry the chain.
If the people thin out, the fire still burns.
No single silence can hold the whole chain again.

The change was set to take hold at block 913982:
the very next block after the stall,
the first block of the chain as it was always meant to be.

## The pool

A chain needs blocks.
Miners need a door to bring their work to.
The pool is that door: a public house with three entrances.

- Port 3333, for the iron: SHA256 ASICs.
- Port 3334, for the people: Yespower CPUs.
- Port 3335, for the fire: Ethash GPUs, speaking the Ethash dialect.

Three ports.
Three kinds of miner.
One house, one daemon behind it, one chain ahead of it.

Every miner who enters proves work, share by share.
A share is a small proof: I was here, I hashed, this much.
Most shares are not blocks.
All of them are counted.

The house runs on humble, proven machinery:
a Node.js stratum server, pinned to Node 16,
patched and extended across three generations of forks,
kept honest by tests that boot the whole house
and mine against it before anyone calls it ready.

## Riders and guilds

Not every miner wants the same bargain.
The house keeps three tables, and a miner's algorithm chooses its own.

**Solo** is the lone rider.
Mine to your own wallet, under your own name.
The coinbase pays your address directly, whole and undivided.
Find a block, and the reward is yours.
Find nothing, and the house owes you nothing.
No ledger of balances. No fee. The old way, kept intact.

**PROP** is the round table.
Miners pool their shares for a round,
from one block to the next.
When a block lands and matures,
its reward is split across the round that found it,
each miner paid in proportion to the work they proved.
The round ends. The next round begins clean.

**PPLNS** is the long memory.
A block's reward is split across the last N shares,
counted back across round boundaries,
so steady work is honoured even when luck arrives late.
Shares age out of the window as new shares arrive.
Loyalty is arithmetic here, not sentiment.

Solo miners ride alone.
Guilds pool their shares.
The house does not pick a favourite table.
It keeps the count at all three.

## Signed promises

In the group modes, the coinbase pays the pool wallet first.
That makes the pool a keeper of other people's earnings,
and a keeper must pay out in a way that can be inspected.

So payouts are not sent on a whisper.
They are built as PSBTs:
Partially Signed Bitcoin Transactions,
promises written down before they are fulfilled.

The stages are separate, and each one is recorded:

1. The batch is built and funded from the pool wallet.
2. The batch is recorded, amounts and all, for anyone to read.
3. The batch is signed.
4. The batch is finalized into a real transaction.
5. The batch is broadcast, and its txid is written beside it.

A batch interrupted halfway is never quietly rebuilt.
The next run picks up the same recorded promise
and finishes the same stages.
One batch, one payment, never two.

And by default, the house rehearses.
Dry-run is the default everywhere:
splits computed, batches built, PSBTs recorded,
and then a full stop before any signing stage.
No funds move until the operator has read the rehearsal,
checked the numbers, and chosen to go live on purpose.

The math is public before the money moves.
That is not a feature bolted on.
That is the order of operations.

## Fairness as law

Any keeper can say: trust me.
This house was built to say: count it yourself.

- Every group block's split is published:
  the reward, the fee, the shares, the weights, the amounts.
- The ledger can be taken away and recounted
  by a standalone verifier that owes the pool nothing.
- The reconciliation is there to be run,
  not there to be believed.
- Shares enter the record only when they are accepted,
  stamped with their algorithm, their miner, their weight, their time.
  Nothing is backdated. Nothing is quietly edited.
  A recorded stage never walks backwards.

A fee is taken in the open, off the top, at a stated rate.
A miner below the minimum payout is not forgotten:
the balance waits in the ledger and carries forward,
block after block, until it is worth sending.

The pool is a public house with its ledger on the table.
Read it. Recount it. That is what it is there for.

## The road ahead

The house has been proven the way a house can be proven
before the guests arrive in earnest:
booted end to end, mined against, counted and recounted,
its promises rehearsed down to the last satoshi.

What remains is the real road:
a living daemon, real miners at the three doors,
a rehearsal watched by human eyes,
and then, when the numbers read true, the first live payment.

Three engines.
Three ports.
One chain that no longer waits on a single kind of strength.

Block 913982 was the door.
This is what walks through it.
