import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
const P = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const le = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);
const pda = (s: string, id: number) => PublicKey.findProgramAddressSync([Buffer.from(s), le(id)], P)[0].toBase58();
console.log("book 930:", pda("anqa_book", 930));
console.log("tape 930:", pda("anqa_tape", 930));
