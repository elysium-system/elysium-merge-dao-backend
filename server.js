require('dotenv').config();

const {
  PORT = '3000',
  RPC_URL,
  MONGODB_URI,
  TWITTER_API_KEY,
  TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_TOKEN_SECRET,
} = process.env;

const express = require('express');
const ethers = require('ethers');
const { from } = require('rxjs');
const { groupBy, mergeMap, concatMap } = require('rxjs/operators');
const mongoose = require('mongoose');
const commander = require('commander');
const Twitter = require('twitter');
const sharp = require('sharp');

const mergeAbi = require('./Merge.json');

const MERGE_ADDRESS = '0xc3f8a0F5841aBFf777d3eefA5047e8D413a1C9AB';
const NUM_ALL_MERGES = 28990;

(async () => {
  try {
    const provider = new ethers.providers.WebSocketProvider(
      RPC_URL,
      'homestead',
    );
    const mergeContract = new ethers.Contract(
      MERGE_ADDRESS,
      mergeAbi,
      provider,
    );

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

    const fetchAndSaveMerges = async () => {
      try {
        const tokenIds = new Array(NUM_ALL_MERGES)
          .fill(null)
          .map((_, idx) => idx + 1);
        const numConcurrReqs = 1000;
        await new Promise((resolve, reject) => {
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
                          const [tier, mass] =
                            await mergeContract.decodeClassAndMass(value);
                          return {
                            tokenId,
                            isExisted: true,
                            tier: tier.toNumber(),
                            mass: mass.toNumber(),
                          };
                        } catch (err) {
                          return {
                            tokenId,
                            isExisted: false,
                            tier: 0,
                            mass: 0,
                          };
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
              next: async (m) => {
                await Merge.findOneAndUpdate(
                  { tokenId: m.tokenId },
                  {
                    isExisted: m.isExisted,
                    tier: m.tier,
                    mass: m.mass,
                  },
                  {
                    upsert: true,
                  },
                ).exec();
              },
              complete: () => {
                resolve();
              },
            });
        });
      } catch (err) {
        console.error(err);
      }
    };

    const program = new commander.Command();
    program
      .option('--blue <id>', 'Our blue token ID', 26984)
      .option('--no-init', 'Skip db init');
    program.parse();
    const options = program.opts();

    await mongoose.connect(MONGODB_URI);

    if (options.init) {
      console.log('Initialize DB...');
      await fetchAndSaveMerges();
      console.log('DB initialized');
    }

    const twitter = new Twitter({
      consumer_key: TWITTER_API_KEY,
      consumer_secret: TWITTER_API_SECRET,
      access_token_key: TWITTER_ACCESS_TOKEN,
      access_token_secret: TWITTER_ACCESS_TOKEN_SECRET,
    });
    mergeContract.on(
      'MassUpdate',
      async (tokenIdSmall, tokenIdLarge, combinedMass) => {
        try {
          const smallerMerge = await Merge.findOneAndUpdate(
            { tokenId: tokenIdSmall },
            { isExisted: false, tier: 0, mass: 0 },
          ).exec();
          if (!smallerMerge) {
            return;
          }

          if (tokenIdLarge.eq(0)) {
            return;
          }
          const largerMerge = await Merge.findOneAndUpdate(
            { tokenId: tokenIdLarge },
            { mass: combinedMass },
          ).exec();
          if (!largerMerge) {
            return;
          }

          const largerMergeOwner = await mergeContract.ownerOf(
            largerMerge.tokenId,
          );
          const numRemainingMerges = await Merge.countDocuments({
            isExisted: true,
          });
          const text = `m(${smallerMerge.mass}) #${smallerMerge.tokenId} + m(${
            largerMerge.mass
          }) #${largerMerge.tokenId} = m(${
            smallerMerge.mass + largerMerge.mass
          }) #${largerMerge.tokenId}
https://opensea.io/assets/${MERGE_ADDRESS}/${largerMerge.tokenId}
${smallerMerge.tier > largerMerge.tier ? `Murderer: ${largerMergeOwner}\n` : ''}
${numRemainingMerges}/${NUM_ALL_MERGES} remain
`;
          console.log(text);

          const metadata = JSON.parse(
            Buffer.from(
              (await mergeContract.tokenURI(largerMerge.tokenId)).split(',')[1],
              'base64',
            ).toString(),
          );
          const img = await sharp(Buffer.from(metadata.image_data))
            .png()
            .toBuffer();
          const media = await twitter.post('media/upload', {
            media: img,
          });
          await twitter.post('statuses/update', {
            status: text,
            media_ids: media?.media_id_string,
          });
        } catch (err) {
          console.error(err);
        }
      },
    );

    const server = express();

    server.get('/blue', async (req, res) => {
      try {
        const blue = await Merge.findOne({ tokenId: options.blue }).exec();
        const numLargerBlues = await Merge.countDocuments({
          isExisted: true,
          tier: 3,
          mass: { $gt: blue.mass },
        });
        const owner = await mergeContract.ownerOf(blue.tokenId);
        res.json({
          mass: blue.mass,
          rank: numLargerBlues + 1,
          owner,
        });
      } catch (err) {
        console.error(err);
      }
    });

    server.listen(Number(PORT), () => {
      console.log(`Listening at http://localhost:${PORT}...`);
    });
  } catch (err) {
    console.error(err);
    await mongoose.disconnect();
  }
})();
