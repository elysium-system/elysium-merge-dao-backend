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
        isAlpha: {
          type: Boolean,
          required: true,
        },
      },
      { timestamps: true },
    );

    const Merge = mongoose.model('Merge', mergeSchema);

    const fetchAndSaveMerges = async () => {
      try {
        const alphaId = await mergeContract._alphaId();
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
                            isAlpha: tokenId === alphaId.toNumber(),
                          };
                        } catch (err) {
                          return {
                            tokenId,
                            isExisted: false,
                            tier: 0,
                            mass: 0,
                            isAlpha: false,
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
            { tokenId: tokenIdSmall.toNumber() },
            { isExisted: false, tier: 0, mass: 0 },
          ).exec();
          if (!smallerMerge) {
            return;
          }

          if (tokenIdLarge.eq(0)) {
            return;
          }
          const largerMerge = await Merge.findOneAndUpdate(
            { tokenId: tokenIdLarge.toNumber() },
            { mass: combinedMass.toNumber() },
          ).exec();
          if (!largerMerge) {
            return;
          }

          const largerMergeOwner = await mergeContract.ownerOf(
            largerMerge.tokenId,
          );
          const largerMergeOwnerEns = await provider.lookupAddress(
            largerMergeOwner,
          );
          const numRemainingMerges = await Merge.countDocuments({
            isExisted: true,
          });
          const mergeTierToEmoji = {
            1: '⚪️',
            2: '🟡',
            3: '🔵',
            4: '🔴',
          };
          const alphaEmoji = '⚫️';
          const alphaId = await mergeContract._alphaId();
          const text = `${mergeTierToEmoji[`${smallerMerge.tier}`]} (${
            smallerMerge.mass
          }) #${smallerMerge.tokenId} → ${
            largerMerge.isAlpha
              ? alphaEmoji
              : mergeTierToEmoji[`${largerMerge.tier}`]
          } (${largerMerge.mass}) #${largerMerge.tokenId} = ${
            largerMerge.tokenId === alphaId.toNumber()
              ? alphaEmoji
              : mergeTierToEmoji[`${largerMerge.tier}`]
          } (${smallerMerge.mass + largerMerge.mass}) #${largerMerge.tokenId}${
            smallerMerge.tier > largerMerge.tier
              ? `\nMurderer: ${largerMergeOwnerEns || largerMergeOwner}`
              : ''
          }
${numRemainingMerges}/${NUM_ALL_MERGES} remain
link: https://opensea.io/assets/${MERGE_ADDRESS}/${largerMerge.tokenId}
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
    mergeContract.on('AlphaMassUpdate', async (alphaId) => {
      try {
        await Merge.findOneAndUpdate(
          { tokenId: alphaId.toNumber() },
          { isAlpha: true },
        ).exec();
      } catch (err) {
        console.error(err);
      }
    });

    const server = express();

    server.get('/blue', async (req, res) => {
      try {
        const blue = await Merge.findOne({ tokenId: options.blue }).exec();
        const numLargerBlues = await Merge.countDocuments({
          isExisted: true,
          tier: 3,
          mass: { $gt: blue.mass },
        });
        const numLargerMerges = await Merge.countDocuments({
          isExisted: true,
          mass: { $gt: blue.mass },
        });
        const owner = await mergeContract.ownerOf(blue.tokenId);
        res.json({
          mass: blue.mass,
          rank: numLargerBlues + 1,
          overallRank: numLargerMerges + 1,
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
