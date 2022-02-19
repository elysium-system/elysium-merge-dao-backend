require('dotenv').config();

const { RPC_URL, EM_DEPLOYER_PRIVATE_KEY } = process.env;

const ethers = require('ethers');

const mergeAbi = require('./Merge.json');
const emAbi = require('./Em.json');

const MERGE_ADDRESS = '0xc3f8a0F5841aBFf777d3eefA5047e8D413a1C9AB';
const EM_ADDRESS = '0x2ab99216416018c2af55eB9376E9FB188C4F5c9C';
const SUB_VAULT_1_ADDRESS = '0xc6a51887ef2933a1175d353e9D04063a4AA1A2C9';

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
    const emContract = new ethers.Contract(EM_ADDRESS, emAbi, provider);
    const targetMass = await emContract.targetMass();
    console.log(`targetMass: ${targetMass}`);

    const signer = new ethers.Wallet(EM_DEPLOYER_PRIVATE_KEY, provider);

    emContract.on('FounderTokenMinted1', async () => {
      const tokenId = await mergeContract.tokenOf(SUB_VAULT_1_ADDRESS);
      const mass = await mergeContract.massOf(tokenId);
      if (mass === targetMass) {
        await emContract.connect(signer).toggleFounderTokenMinting1();
      }
    });
  } catch (err) {
    console.error(err);
  }
})();
