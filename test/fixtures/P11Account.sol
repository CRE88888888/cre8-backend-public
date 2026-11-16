// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Local integration fixture. Registry consent requires the owner's sudo call.
contract P11Account {
    address public immutable owner;
    constructor(address owner_) { owner = owner_; }
    function sudo(address target, bytes calldata data) external {
        require(msg.sender == owner, "owner required");
        (bool success, bytes memory result) = target.call(data);
        if (!success) assembly { revert(add(result, 32), mload(result)) }
    }
}
