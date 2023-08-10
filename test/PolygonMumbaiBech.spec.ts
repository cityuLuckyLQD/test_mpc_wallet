import { expect } from "chai";
import { BigNumber, Contract, ContractFactory, Overrides, Wallet } from "ethers";
import { formatBytes32String, hexlify, keccak256, randomBytes, solidityPack, toUtf8Bytes, toUtf8String } from "ethers/lib/utils";
import { ethers } from "hardhat";
import * as hre from "hardhat";
import NodeRSA from "node-rsa";
import {
    ASSETS_OP_THRESHOLD,
    getKeysetHash,
    GUARDIAN_TIMELOCK_THRESHOLD,
    initDkimZK,
    OPENID_AUDIENCE,
    OPENID_ISSUER,
    OPENID_KID,
    optimalGasLimit,
    OWNER_THRESHOLD,
    transferEth,
} from "./utils/common";
import { Deployer } from "./utils/deployer";
import { KeyBase, randomKeys, selectKeys } from "./utils/key";
import {
    CallType,
    executeCall,
    generateSyncAccountTx,
    generateTransactionSig,
    generateTransferTx,
    generateUpdateKeysetHashTx,
    generateUpdateTimeLockDuringTx,
    Role,
} from "./utils/sigPart";


describe("Wallet Register And Recovery Test", function () {
    let testERC1271Wallet: [Contract, Wallet][] = [];
    let moduleMain: Contract;
    let ModuleMain: ContractFactory;
    let moduleMainUpgradable: Contract;
    let ModuleMainUpgradable: ContractFactory;
    let proxyModuleMain: Contract;
    let deployer: Deployer;
    let dkimKeys: Contract;
    let keysetHash: string;
    let keys: KeyBase[];
    let dkimKeysAdmin: Wallet;
    let testErc20Token: Contract;
    let value: number;
    let txParams: Overrides;
    let chainId: number;
    let unipassPrivateKey: NodeRSA;
    let nonce: number;
    let metaNonce: number;
    let Greeter: ContractFactory;
    let greeter1: Contract;
    let greeter2: Contract;
    let moduleWhiteListAdmin: Wallet;

    let openIDAdmin: Wallet;
    let openID: Contract;
    let dkimZKAdmin: Wallet;
    let dkimZK: Contract;
    const zkServerUrl = process.env.ZK_SERVER_URL;

    this.beforeAll(async function () {
        const TestERC1271Wallet = await ethers.getContractFactory("TestERC1271Wallet");
        const [signer] = await ethers.getSigners();
        chainId = (await signer.provider!.getNetwork()).chainId;
        deployer = await new Deployer(signer).init();
        txParams = {
            gasLimit: 10000000,
            gasPrice: (await signer.provider?.getGasPrice())?.mul(12).div(10),
        };
        for (let i = 0; i < 20; i++) {
            const wallet = Wallet.createRandom();
            testERC1271Wallet.push([await deployer.deployContract(TestERC1271Wallet, i, txParams, wallet.address), wallet]);
        }
        Greeter = await ethers.getContractFactory("Greeter");
        greeter1 = await deployer.deployContract(Greeter, 1, txParams);
        greeter2 = await deployer.deployContract(Greeter, 2, txParams);

        moduleWhiteListAdmin = Wallet.createRandom().connect(signer.provider!);
        await transferEth(moduleWhiteListAdmin.address, 1);
        const ModuleWhiteList = await ethers.getContractFactory("ModuleWhiteList");
        const moduleWhiteList = await (
            await deployer.deployContract(ModuleWhiteList, 0, txParams, moduleWhiteListAdmin.address)
        ).connect(moduleWhiteListAdmin);

        let ret = await (await moduleWhiteList.updateImplementationWhiteList(greeter1.address, true)).wait();
        expect(ret.status).to.equals(1);
        ret = await (await moduleWhiteList.updateHookWhiteList(greeter2.address, true)).wait();
        expect(ret.status).to.equals(1);

        // TODO: load bin from file and set admin
        const DkimZK = await ethers.getContractFactory("DkimZK");
        dkimZKAdmin = Wallet.createRandom().connect(signer.provider!);
        await transferEth(dkimZKAdmin.address, 10);
        dkimZK = (await deployer.deployContract(DkimZK, 0, txParams, dkimZKAdmin.address)).connect(dkimZKAdmin);
        await initDkimZK(dkimZK);

        const DkimKeys = await ethers.getContractFactory("DkimKeys");
        dkimKeysAdmin = Wallet.createRandom().connect(signer.provider!);
        await transferEth(dkimKeysAdmin.address, 1);
        dkimKeys = (await deployer.deployContract(DkimKeys, 0, txParams, dkimKeysAdmin.address, dkimZK.address)).connect(
            dkimKeysAdmin
        );
        const OpenID = await ethers.getContractFactory("OpenID");
        openIDAdmin = Wallet.createRandom().connect(signer.provider!);
        await transferEth(openIDAdmin.address, 10);
        openID = (await deployer.deployContract(OpenID, 0, txParams, openIDAdmin.address)).connect(openIDAdmin);

        ModuleMainUpgradable = await ethers.getContractFactory("ModuleMainUpgradable");
        moduleMainUpgradable = await deployer.deployContract(
            ModuleMainUpgradable,
            0,
            txParams,
            dkimKeys.address,
            openID.address,
            moduleWhiteList.address
        );
        ret = await (await moduleWhiteList.updateImplementationWhiteList(moduleMainUpgradable.address, true)).wait();
        expect(ret.status).to.equals(1);
        ModuleMain = await ethers.getContractFactory("ModuleMain");
        moduleMain = await deployer.deployContract(
            ModuleMain,
            0,
            txParams,
            deployer.singleFactoryContract.address,
            moduleMainUpgradable.address,
            dkimKeys.address,
            openID.address,
            moduleWhiteList.address
        );

        const TestErc20Token = await ethers.getContractFactory("TestERC20");
        testErc20Token = await TestErc20Token.deploy();

        unipassPrivateKey = new NodeRSA({ b: 2048 });
        ret = await (
            await dkimKeys.updateDKIMKey(
                solidityPack(["bytes32", "bytes32"], [formatBytes32String("s2055"), formatBytes32String("unipass.com")]),
                unipassPrivateKey.exportKey("components-public").n.slice(1)
            )
        ).wait();
        expect(ret.status).to.equals(1);
        ret = await (
            await openID.updateOpenIDPublicKey(
                keccak256(solidityPack(["bytes", "bytes"], [toUtf8Bytes(OPENID_ISSUER), toUtf8Bytes(OPENID_KID)])),
                unipassPrivateKey.exportKey("components-public").n.slice(1)
            )
        ).wait();
        expect(ret.status).to.equals(1);
        ret = await (
            await openID.addOpenIDAudience(
                keccak256(solidityPack(["bytes", "bytes"], [toUtf8Bytes(OPENID_ISSUER), toUtf8Bytes(OPENID_AUDIENCE)]))
            )
        ).wait();
        expect(ret.status).to.equals(1);
    });

    this.beforeEach(async function () {
        keys = await randomKeys(unipassPrivateKey, testERC1271Wallet, zkServerUrl);
        keysetHash = getKeysetHash(keys);

        proxyModuleMain = await deployer.deployProxyContract(moduleMain.interface, moduleMain.address, keysetHash, txParams);
        const txRet = await (
            await ethers.getSigners()
        )[0].sendTransaction({
            to: proxyModuleMain.address,
            value: ethers.utils.parseEther("100"),
        });
        expect((await txRet.wait()).status).to.equal(1);

        value = 100;
        let ret = await (await testErc20Token.mint(proxyModuleMain.address, value)).wait();
        expect(ret.status).to.equal(1);
        expect(await testErc20Token.balanceOf(proxyModuleMain.address)).to.equal(value);

        metaNonce = 1;
        nonce = 1;
    });

    describe("Test User Register", async () => {
        let keys: KeyBase[];
        let userAddress: string;
        let keysetHash: string;
        it("User Not Registered", async () => {
            keys = await randomKeys(unipassPrivateKey, testERC1271Wallet, zkServerUrl);
            keysetHash = getKeysetHash(keys);

            userAddress = deployer.getProxyContractAddress(moduleMain.address, keysetHash);

            const code = await moduleMain.provider.getCode(userAddress);
            expect(code).to.equal("0x");
        });

        it("User Registered", async () => {
            await deployer.deployProxyContract(moduleMain.interface, moduleMain.address, keysetHash, txParams);
            const code = await moduleMain.provider.getCode(userAddress);
            expect(code).to.not.equal("0x");
            console.log("user address is " + userAddress);
        });
    });

    it("Test Account Recovery", async () => {
        const newKeysetHash = hexlify(randomBytes(32));
        const selectedKeys = selectKeys(keys, Role.Guardian, GUARDIAN_TIMELOCK_THRESHOLD);
        const tx = await generateUpdateKeysetHashTx(
            chainId,
            proxyModuleMain,
            metaNonce,
            newKeysetHash,
            true,
            Role.Guardian,
            selectedKeys
        );

        const ret = await executeCall([tx], chainId, nonce, [], proxyModuleMain, undefined, txParams);
        expect(ret.status).to.equal(1);
        const lockInfo = await proxyModuleMain.getLockInfo();
        expect(lockInfo.isLockedRet).to.true;
        expect(lockInfo.lockedKeysetHashRet).to.equal(newKeysetHash);
        metaNonce++;
        nonce++;
    });

    it("Test Sync Account", async () => {
        const selectedKeys = selectKeys(keys, Role.Owner, OWNER_THRESHOLD);
        const tx = await generateSyncAccountTx(
            chainId,
            proxyModuleMain,
            metaNonce,
            keysetHash,
            30,
            moduleMainUpgradable.address,
            selectedKeys
        );

        const ret = await executeCall([tx], chainId, nonce, [], proxyModuleMain, undefined, txParams);
        expect(ret.status).to.equal(1);
        expect(await proxyModuleMain.getKeysetHash()).to.equals(keysetHash);
        expect(await proxyModuleMain.getImplementation()).to.equals(moduleMainUpgradable.address);
        metaNonce++;
        nonce++;
    });

    it("Test Transfer Eth", async () => {
        const { chainId } = await proxyModuleMain.provider.getNetwork();
        const sessionKey = Wallet.createRandom();
        const timestamp = Math.ceil(Date.now() / 1000 + 5000);
        const selectedKeys = selectKeys(keys, Role.AssetsOp, ASSETS_OP_THRESHOLD);

        const to1 = Wallet.createRandom();
        const to2 = Wallet.createRandom();
        const value1 = BigNumber.from(10);
        const value2 = BigNumber.from(20);
        const tx1 = {
            revertOnError: true,
            callType: CallType.Call,
            gasLimit: optimalGasLimit,
            target: to1.address,
            value: value1,
            data: "0x",
        };
        const tx2 = {
            callType: CallType.Call,
            gasLimit: optimalGasLimit,
            target: to2.address,
            value: value2,
            revertOnError: true,
            data: "0x",
        };

        const signature = generateTransactionSig(chainId, proxyModuleMain.address, [tx1, tx2], nonce, selectedKeys, {
            key: sessionKey,
            timestamp,
            weight: 100,
        });

        const recipt = await (await proxyModuleMain.execute([tx1, tx2], nonce, signature)).wait();
        expect(recipt.status).to.equal(1);
        expect(await proxyModuleMain.provider.getBalance(to1.address)).equal(value1);
        expect(await proxyModuleMain.provider.getBalance(to2.address)).equal(value2);
        expect(await proxyModuleMain.getNonce()).to.equal(nonce);
        nonce++;
    });

    it("Test Transfer Erc20", async () => {
        const { chainId } = await proxyModuleMain.provider.getNetwork();
        const sessionKey = Wallet.createRandom();
        const timestamp = Math.ceil(Date.now() / 1000 + 5000);
        const selectedKeys = selectKeys(keys, Role.AssetsOp, ASSETS_OP_THRESHOLD);

        const to1 = Wallet.createRandom();
        const to2 = Wallet.createRandom();
        const value1 = 10;
        const value2 = 20;
        const data1 = testErc20Token.interface.encodeFunctionData("transfer", [to1.address, value1]);
        const data2 = testErc20Token.interface.encodeFunctionData("transfer", [to2.address, value2]);
        const tx1 = {
            callType: CallType.Call,
            revertOnError: true,
            gasLimit: ethers.constants.Zero,
            target: testErc20Token.address,
            value: ethers.constants.Zero,
            data: data1,
        };
        const tx2 = {
            revertOnError: true,
            callType: CallType.Call,
            gasLimit: ethers.constants.Zero,
            target: testErc20Token.address,
            value: ethers.constants.Zero,
            data: data2,
        };

        const signature = generateTransactionSig(chainId, proxyModuleMain.address, [tx1, tx2], nonce, selectedKeys, {
            key: sessionKey,
            timestamp,
            weight: 100,
        });

        const recipt = await (await proxyModuleMain.execute([tx1, tx2], nonce, signature)).wait();
        expect(recipt.status).to.equal(1);
        expect(await testErc20Token.balanceOf(to1.address)).equal(value1);
        expect(await testErc20Token.balanceOf(to2.address)).equal(value2);
        expect(await proxyModuleMain.getNonce()).to.equal(nonce);
        nonce++;
    });

});
