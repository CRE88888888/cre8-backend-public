import type { Address } from 'viem';

/** Generated from cre8-contracts deployments/testnet-97.json (manifest gitCommit below),
 * script/testnet/TestnetAssets.sol at f7e5d52bce5d14a05cc64a97cd7e67f1acf5e428.
 * Kernel/policy: pinned backend SDK versions, verified on the chain 97 fork.
 * Quoter: https://developer.pancakeswap.finance/contracts/v3/addresses (BSC TESTNET).
 * maxLegUsdt: conservative existing admission caps, db 0024 at 3dd4302;
 * copied by symbol at generation time, never looked up in the mainnet DB at runtime.
 */
export const TESTNET_97 = {
  "chainId": 97,
  "sourceCommit": "f7e5d52bce5d14a05cc64a97cd7e67f1acf5e428",
  "mode": "fork",
  "note": "fork = verified on a local anvil fork of chain 97; the public deployment lands on the same CREATE2 addresses",
  "verifiedAtBlock": 142687759,
  "generatedAt": "2026-11-14T13:00:50Z",
  "gitCommit": "f45713e7c20e901e44cd4beb0d2f5a766e019200",
  "roles": {
    "deployer": "0x55662b4183fca1230694d5d57f56e4f2e0e3008a",
    "owner": "0x09bbb9a06a0c49ad24bddb18808944041783054e",
    "operator": "0xd8ce3295e05ca138e0d0d7214c4fd630c43f9d7f",
    "keeper": "0xa38ddfb9fdf0043cf61b00e1a8d12fa1431f92d5",
    "paymasterSigner": "0xf5645ff8fa773246010f7c9dddff8e590e800495",
    "feeRecipient": "0x3b5ede5af574e7d8f3b72143e09dc242dd1f0462",
    "bundlerExecutor": "0xcc0ea01356d75aa5295d364344753f136b77ee28",
    "bundlerUtility": "0x6735c14bf84c8cb0d64bf2fb51b7587ade7b2960"
  },
  "contracts": {
    "ownedDeployer": "0x35500b1dd850763fd67ed89a04abfe7a15c443a3",
    "registry": "0x88e5d2d14985f34539ffd67210f3d06963f3cce1",
    "router": "0x625037c1e176b9c297d93fd729fee2212979a170",
    "executor": "0xdf33a5b2a897557bc2bcc446ace1791abe1c88d3",
    "usdt": "0xbd7d814e02c9f69af391a8ba4c1787769f2ddd4b",
    "feed.USDT/USD": "0x9612a567213d3ced8d8328b34fcaf6685c73af02",
    "paymaster": "0xa8ac1cc4846f72a32af0302ae5ae03b1a8dbaafa",
    "gasPolicy": "0xaefc5abc67ffd258abd0a3e54f65e70326f84b23",
    "entryPoint": "0x0000000071727de22e5e9d8baf0edac6f37da032",
    "v3Factory": "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
    "positionManager": "0x427bf5b37357632377ecbec9de3626c71a5396c1",
    "universalRouter": "0x9a082015c919ad0e47861e5db9a1c7070e81a2c7",
    "permit2": "0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768",
    "quoter": "0xbc203d7f83677c7ed3f7acec959963e7f4ecc5c2",
    "kernelMetaFactory": "0xd703aae79538628d27099b8c4f621be4ccd142d5",
    "kernelFactoryV33": "0x2577507b78c2008ff367261cb6285d44ba5ef2e9",
    "kernelImplV33": "0xd6cedde84be40893d153be9d467cd6ad37875b28",
    "ecdsaValidatorV31": "0x845adb2c711129d4f3966735ed98a9f09fc4ce57",
    "callPolicy": "0x9a52283276a0ec8740df50bf01b28a80d880eaf2",
    "timestampPolicy": "0xb9f8f524be6ecd8c945b1b87f9ae5c192fdce20f",
    "ecdsaSigner": "0x6a6f069e2a08c2468e7724ab3250cdbfba14d4ff"
  },
  "assets": {
    "AAPLB": {
      "token": "0x6de69565f250146c67d56be5aa15b6f181fce4d7",
      "pool": "0x223105fdcab05dcde383e9a0c66d302f5440dfa9",
      "oracle": "0x4c81ee9415075e99a0a1ec5638da7122c1156e2a",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "156240"
    },
    "AMZNB": {
      "token": "0x2c1d0eb771f8a17b78ea1855c0a896bc5ba8e85a",
      "pool": "0x84dd25c9ce45d6357aaaca19d0763f696ef2c73a",
      "oracle": "0x3fe97af7b8d4a26b751f562168680388e89468cf",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "22890"
    },
    "AVAX": {
      "token": "0x4251ddb21558a783a89982712a19c6a0e13eaa96",
      "pool": "0x2f990657e5f503b38523ea26eda0c14795c3655b",
      "oracle": "0x0927f94b1af5554f126805035d146d25bffced96",
      "feed": "0xa5e212ee4fdcb7d34aae64104e03bf98e4f6abc4",
      "secondary": "0x8ed07dbd05ea21abb51b64f40e78bdb8c5092559",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "9940"
    },
    "BABAB": {
      "token": "0xaa2f20dc2dcdf3fed139e39651af3a889cfb5f8b",
      "pool": "0xac9fc51b3f709894b0e387ab979cca16a1fe3a39",
      "oracle": "0x9955a13acf94314a34160a81b2b72dc028cba216",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "71750"
    },
    "BTCB": {
      "token": "0x15a4d70ef4400638b5c623997a1a4d0f559e6407",
      "pool": "0xab376db4c5a542e16f511ca74397ac6df98e7a3b",
      "oracle": "0x396a62ead5d65aa7226b2fc27a66ba18e584bc2c",
      "feed": "0xaa5532696039d5601f12eba07fb2cc1a10314756",
      "secondary": "0x47580eab949dd707d7bf562621b3d4c1a68bad50",
      "decimals": 18,
      "poolFee": 500,
      "maxLegUsdt": "3464790"
    },
    "CRCLB": {
      "token": "0xa663434d6f59e3a4fb82b966e6540e0a5d772e70",
      "pool": "0xcc7386ec4ef4672ac6741866b143ee2452c1da2d",
      "oracle": "0x9c7bf7ddbea84871f2f3efcd4ed61b1aa87af6c4",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "68320"
    },
    "DJTB": {
      "token": "0x98c934259253909461923a25d436ffb0ce53801d",
      "pool": "0x7dbefd415b50e69388d20386dcdb27d823f6ad42",
      "oracle": "0xb3769914dbedf29f351828a58b9340c06f45d411",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "910"
    },
    "DOGE": {
      "token": "0xbde73353ce69900f0ffed9cc939894d310939cac",
      "pool": "0x9d21a080aa35aeac5a9787ba6854d4dc52c3bd9e",
      "oracle": "0x3cd5d450166a2c01df08ce33b17f7ec9762ea060",
      "feed": "0x1fd6abe4eafe37d2261a629a68dc4171c99e8c94",
      "secondary": "0x55c883667fdc335f018156f0dd25945fc339399f",
      "decimals": 8,
      "poolFee": 10000,
      "maxLegUsdt": "44030"
    },
    "ETH": {
      "token": "0x30fdab8087bcc5bfcab8b8607ded8512d56ea00b",
      "pool": "0x0fe414b83cfd0e9518159e6c1bd6f7ffa9bc71ad",
      "oracle": "0x2f63b105ec77243097c379c169d2318be5d9b592",
      "feed": "0xf3f6b4c266625ff43ed97b84a90f6d450ec15396",
      "secondary": "0xfac6c549236c6be1926997b4706b914524d4d3fc",
      "decimals": 18,
      "poolFee": 500,
      "maxLegUsdt": "2187360"
    },
    "EWYB": {
      "token": "0x9075fbfe8b7ada95a87ba7691064cc19cdc31250",
      "pool": "0xef486a29de7ee8f689fce6744c5cf88b784bb622",
      "oracle": "0xecfa943edade1f1f5d297be1ce5ad1917b0481d8",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "32550"
    },
    "GOOGLB": {
      "token": "0x1588f61dfc020b2f213c0402412d320bfe0ea62b",
      "pool": "0x164316961de969c176a123763232e96000a7c942",
      "oracle": "0xb551cf63c7d72e57a911a8f13313e9b0149782c6",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "113540"
    },
    "HOODB": {
      "token": "0x19ca5fb5cbcacf6ff743ecc313e1cbd317077a01",
      "pool": "0xaa0c54562bd0c5e569ff03bbe15f79bf89d31665",
      "oracle": "0xc38b15f0d6eb4125c41ee5ac826e493ad9d8dcf5",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "6790"
    },
    "INTCB": {
      "token": "0x32cb3ec5e5546a33494bb3c929cbef903ed79e34",
      "pool": "0x90cfbcc6b6e781c42ab1a122d3722f9a5e9bed04",
      "oracle": "0x3fd7c156c2b30a693918ba0fdd54ce931fa50c6b",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "107800"
    },
    "METAB": {
      "token": "0x879766bcbb063b408c95422bc7e749dff8fca51e",
      "pool": "0xe55a1963d3360eb2eb51decec7f08026bd415d08",
      "oracle": "0x433754c471bf82ac356c19373ae867aa0d74b79f",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "38570"
    },
    "MRNAB": {
      "token": "0x299a6513333561eb70d0d421343cf0374e19ea08",
      "pool": "0xe9a77b0830abd1f65b068b0d455e7d7596730746",
      "oracle": "0x63201c62e2b9acb2e27898c55242b16749dcc9ff",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "10150"
    },
    "MSFTB": {
      "token": "0x85625b081f5c22b77bd93e1064b3be54e797bf77",
      "pool": "0x00e28b75d5a53df93caa735868a434484a7c7107",
      "oracle": "0x85bc78188d6c7c850e5eecc7dbc1b1db4d604ce3",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "44660"
    },
    "MSTRB": {
      "token": "0xe19e5cc9b15f400074b46d5ed4c0ae510800c121",
      "pool": "0xe5e92f584c674ab06f54f13722b3f5c20063338f",
      "oracle": "0x59260478009b7863d127e8ce55126f169b503785",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "29750"
    },
    "MUB": {
      "token": "0xf0913c6110227b37a924420814a192a1640b7f06",
      "pool": "0xcaf0dd8463ef4ac8f87f78a45d74785cdcd4f938",
      "oracle": "0x283e3fa4272021afa9fd0e88ea5049f765a6c96f",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "77980"
    },
    "NFLXB": {
      "token": "0x21d05538b0c0f91615b5088f8789bbcc87b60e8d",
      "pool": "0x1c0dd7796b24e54341c1e077523e00a6ce0a86b2",
      "oracle": "0x9207b8673c4c67267b4f5012a83385ccc9a08863",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "12180"
    },
    "NOKB": {
      "token": "0x80fd69173d96b3eecdfdda9bbab0be0e5006599c",
      "pool": "0xf203524fdd3a7f187fed1e21435c05c4cbf4005c",
      "oracle": "0x7ea5b4c12ada9da76d1f076357be528fc51c90a4",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "3570"
    },
    "NVDAB": {
      "token": "0x7cca0faff746f534e9fccb3bd957638a62321303",
      "pool": "0xe49f08604f985839e97172844e69dd90b55d85cd",
      "oracle": "0x66b02529f01b952acf2744a50515f1cc0f605581",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "590800"
    },
    "QQQB": {
      "token": "0x6f39d49a580a9004218f36d309a2c5001fa2d3a2",
      "pool": "0xdc7507b07aa1828b2623222e18b3f46cbc610630",
      "oracle": "0xc8b45232efad3db004f2d70b9db0456f832a9ece",
      "decimals": 18,
      "poolFee": 500,
      "maxLegUsdt": "791560"
    },
    "SGOVon": {
      "token": "0x088a76151f83d797fba02ce80caa18cd1b886e6b",
      "pool": "0x04f5a1a691eaacfe393d961b0984f984b92f6936",
      "oracle": "0x20573910b35a244d81d8a6b1b51113534b4d5e61",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "279790"
    },
    "SKHYB": {
      "token": "0xdf214e855d81077973f166d894653c33faedfe25",
      "pool": "0xd0e793f44fbb4e70e446d2f626502645e403d57e",
      "oracle": "0x5be4aa1edac3e004b534a6c2e3b97b628a9a3bda",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "297430"
    },
    "SNDKB": {
      "token": "0x2eac951a0fed4d2fcf2b60797a8aa93b87a8c73a",
      "pool": "0x02e2fda0c380c3a6a4fddcca0703d9e569062a8d",
      "oracle": "0x01d5419662d2c2b95f7538cd10427278b05a76f6",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "20230"
    },
    "SOL": {
      "token": "0x938c7750a8752f5e5e1bfa533c350d1a2dc7faf0",
      "pool": "0xf83ebc116db895848262d136fd9d88fe47436026",
      "oracle": "0x165e51126f2e0854ec464be948ff35a4417db48f",
      "feed": "0xe458359506f26c40b053cf91a0a827973b4205e8",
      "secondary": "0x98ade84e2147882811f54c98f4d932ca0f119ed4",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "115500"
    },
    "SPCXB": {
      "token": "0x6069d85fff97f7f1b7694341a4d81d051bded136",
      "pool": "0xc9f1efac6e42ccd63f41020a2279894d68a01a17",
      "oracle": "0x3bd8dd28ca933e34da3d066dd78681ce3a9cee33",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "695240"
    },
    "SPYB": {
      "token": "0x6e43fb73434a81ac95625256f1a704431a50fba2",
      "pool": "0x3f2302592e4c3ba220425682db90017fbe46442a",
      "oracle": "0xd735eab1c81e227c0227c28ba2e783459666dddf",
      "decimals": 18,
      "poolFee": 100,
      "maxLegUsdt": "110390"
    },
    "TLTon": {
      "token": "0x6a0cd0d440a946edfee9d4a0c0bd362c2a4225b5",
      "pool": "0xef7efd2f1126126b7ee2c8206f902a97d881520c",
      "oracle": "0xb3890c773181a252511f3b20a3993e3e3bb84d26",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "1400000"
    },
    "TRX": {
      "token": "0x69103b2b48a5ab51bce96d2d14169f6b612cd4e2",
      "pool": "0x5485be2e3ef3a134abaab141f68a662bce27146c",
      "oracle": "0xb2a76cfa14e9a6d0f80f09fc9648c19ee01fde7f",
      "feed": "0xd8167f60eccba3629947a4e33c6a9d3e26df82bf",
      "secondary": "0x4555eeba4fdef580e259a043fff4e82d0ddb0345",
      "decimals": 6,
      "poolFee": 2500,
      "maxLegUsdt": "35280"
    },
    "TSLAB": {
      "token": "0x7c4d269987a85d30a8e7cd46e8eaff2c739a44d2",
      "pool": "0x96ba1bb32f79a2f3c8b7d9cb51ae5e902d71825e",
      "oracle": "0xaddfeacb0c4a96cf03ec212c0bf0bbcb37ed7a24",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "294490"
    },
    "TSMB": {
      "token": "0x414450e39bfc5faec290a99b23c3cd8f5b2591af",
      "pool": "0xc34ea1b3b724e9b8a3fd1fb6c3e3cc002b666a5a",
      "oracle": "0x690d6d3b37702fda1db69b6d4340c82b050e9058",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "10570"
    },
    "WBNB": {
      "token": "0x8ca7ef628e212e40ab9ce65338a4a3ddbc99b9ac",
      "pool": "0xbcc0f7454679510bec5dd82d7df56096827bcc4b",
      "oracle": "0x43b40859dda34404506d115043460f6b2329fa06",
      "feed": "0x0c3cddef1270540d6366d9ce3fea8c643d0ef1bf",
      "secondary": "0x90140d97dc6a8cc09a0fdc71c910f4ff37bf75d7",
      "decimals": 18,
      "poolFee": 500,
      "maxLegUsdt": "1398040"
    },
    "XAUt": {
      "token": "0xfdaea502817d7ce35ca3a89dac5b0f53556e3b9e",
      "pool": "0x9a36f0903da57281c1ebc76aeec26137889a8ab7",
      "oracle": "0x1583ed7e8e37e77dd11aad5cbeef4457386c83c6",
      "decimals": 6,
      "poolFee": 500,
      "maxLegUsdt": "232960"
    },
    "XRP": {
      "token": "0xb9e6e6a000c21039867724c65313373b90e8f3dd",
      "pool": "0x74641c48d109535a8cc5ca159ee735de35b0754c",
      "oracle": "0x2d04b9a3de364137ccd88eab3d479d0cc22a8cc0",
      "feed": "0x4ffef9a114b49ac870037b1b856ab7c3dc028272",
      "secondary": "0x34277c4bc9814a9ea7e44f9270da78ad9285ad02",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "115990"
    },
    "USDC": {
      "token": "0x30cdbed776c5d483f655f2ce614860f6e7666218",
      "pool": "0x3e7cb63d051e279e1d45be87aff927f8a08a9ec4",
      "oracle": "0x04a423fb00431f56a046a97e4bf29d817d625578",
      "feed": "0x6e99c8a8de866bac6a5c68de0abc20621f1b4968",
      "secondary": "0x351db06b0d78867110cf30e8a4664752a1b961cd",
      "decimals": 18,
      "poolFee": 100,
      "maxLegUsdt": "17852520"
    },
    "DAI": {
      "token": "0x3bcfb731e707278239b9c2483d6bca3bbf284c6f",
      "pool": "0x96f4884f33cd0c77cdd82c8934ee3da680f1deca",
      "oracle": "0x1735805b1a6494f7283f38deaaafa25fe80e3ce9",
      "feed": "0x8c46d34d4c385ad8b45abf4c493c5790b21b6478",
      "secondary": "0xd51d502b76da2ae0af2b62d9bfe593c0dbed03b2",
      "decimals": 18,
      "poolFee": 100,
      "maxLegUsdt": "19390"
    },
    "LTC": {
      "token": "0x7874511188b2ea81f2ba4e177a8eced23e5a28b0",
      "pool": "0x7b2e7c8287a7b7dc3757538f8b7bb6bf8a704647",
      "oracle": "0xd2e007c2dd7bc01e49bfc61bb0de00871eaace28",
      "feed": "0x750f3415122ae9cf34e6cab35acef883a37b0113",
      "secondary": "0x0a7c1db29ad9991c4af9132a69c93ee52125fc60",
      "decimals": 18,
      "poolFee": 2500,
      "maxLegUsdt": "42000"
    }
  }
} as const;

export function configuredChainId(): number {
  const id = Number(process.env.CHAIN_ID?.trim() || '56');
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid CHAIN_ID');
  return id;
}

export function testnetAssets() {
  return [
    { address: TESTNET_97.contracts.usdt, symbol: 'USDT', decimals: 18, is_numeraire: true, usdt_pool: null, max_leg_usdt: null },
    ...Object.entries(TESTNET_97.assets).map(([symbol, asset]) => ({ address: asset.token, symbol, decimals: asset.decimals,
      is_numeraire: false, usdt_pool: asset.pool, max_leg_usdt: asset.maxLegUsdt })),
  ];
}

/** Reject explicit foreign addresses; empty settings resolve to the pinned deployment. */
export function profileAddress(chainId: number, name: string, raw: Address | null): Address | null {
  if (chainId !== 97) return raw;
  const addresses: Record<string, Address> = {
    REGISTRY_ADDRESS: TESTNET_97.contracts.registry, EXECUTOR_ADDRESS: TESTNET_97.contracts.executor,
    PAYMASTER_ADDRESS: TESTNET_97.contracts.paymaster, PAYMASTER_MOCK_USDT_ADDRESS: TESTNET_97.contracts.usdt,
  };
  const expected = addresses[name];
  if (expected === undefined) throw new Error('Unknown profile address setting');
  if (raw !== null && raw.toLowerCase() !== expected) throw new Error(name + ' must match chain 97 profile');
  return expected;
}
