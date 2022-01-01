require('dotenv').config();

const {
  PORT = '3000',
  BLUE_TOKEN_ID = '26984',
  RPC_URL,
  MONGODB_URI,
} = process.env;

const express = require('express');
const ethers = require('ethers');
const { from } = require('rxjs');
const { groupBy, mergeMap, concatMap } = require('rxjs/operators');
const mongoose = require('mongoose');
const commander = require('commander');

const mergeAbi = require('./Merge.json');

const MERGE_ADDRESS = '0xc3f8a0F5841aBFf777d3eefA5047e8D413a1C9AB';

const provider = new ethers.providers.WebSocketProvider(RPC_URL, 'homestead');
const mergeContract = new ethers.Contract(MERGE_ADDRESS, mergeAbi, provider);

const fetchMerges = async () => {
  const nextId = await mergeContract._nextMintId();
  const tokenIds = new Array(nextId.toNumber() - 1)
    .fill(null)
    .map((_, idx) => idx + 1);
  const numConcurrReqs = 1000;
  return new Promise((resolve, reject) => {
    let merges = [];
    from(tokenIds)
      .pipe(
        groupBy((tokenId) => tokenId % numConcurrReqs),
        mergeMap((group$) =>
          group$.pipe(
            concatMap((tokenId) =>
              from(
                (async () => {
                  try {
                    const value = await mergeContract.getValueOf(tokenId);
                    const [tier, mass] = await mergeContract.decodeClassAndMass(
                      value,
                    );
                    return {
                      tokenId,
                      isExisted: true,
                      tier: tier.toNumber(),
                      mass: mass.toNumber(),
                    };
                  } catch (err) {
                    return { tokenId, isExisted: false, tier: 0, mass: 0 };
                  }
                })(),
              ),
            ),
          ),
        ),
      )
      .subscribe({
        error: (err) => {
          reject(err);
        },
        next: (res) => {
          merges = [...merges, res];
        },
        complete: () => {
          resolve(merges);
        },
      });
  });
};

const mergeSchema = new mongoose.Schema(
  {
    tokenId: {
      type: Number,
      required: true,
      index: {
        unique: true,
      },
    },
    isExisted: {
      type: Boolean,
      required: true,
    },
    tier: {
      type: Number,
      required: true,
    },
    mass: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true },
);

const Merge = mongoose.model('Merge', mergeSchema);

const program = new commander.Command();
program.option('--skip', 'Skip fetching all merges', false);
program.parse(process.argv);
const options = program.opts();

(async () => {
  await mongoose.connect(MONGODB_URI);

  const server = express();

  if (!options.skip) {
    console.log('Fetching merges...');
    const merges = await fetchMerges();
    await Promise.all(
      merges.map((m) =>
        Merge.updateOne({ tokenId: m.tokenId }, m, { upsert: true }),
      ),
    );
  }

  server.get('/blue', async (req, res) => {
    const merge = await Merge.findOne({ tokenId: BLUE_TOKEN_ID }).exec();
    const numBiggerMerges = await Merge.countDocuments({
      isExisted: true,
      tier: 3,
      mass: { $gt: merge.mass },
    });
    res.json({
      mass: merge.mass,
      rank: numBiggerMerges + 1,
    });
  });

  server.listen(Number(PORT), () => {
    console.log(`Listening at http://localhost:${PORT}`);
  });
})();
