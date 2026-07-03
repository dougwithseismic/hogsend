Hey, I'm Steven. I'm a support engineer at Post Hog and I'm going to take you backstage for a look at how we use session replay to help us do support. So, when someone opens a ticket from within our system, we include some information about the session they were in when they open that ticket.

And one of the things that we include is a link to the session recording. By the way, stick around and I will show you where you can get information about how to set up a link like that in your own system. So this is really helpful in cases where the user doesn't tell you much about why they opened the ticket.

For example, this user didn't tell us which insight that they were working on, uh what it was that looked wrong about the graph, what they were doing just before they noticed the problem, etc. Once upon a time, there was not much you could do but to reply to the user and ask for more information.

But now with session recording, you can have a look at what they were up to just before they opened that ticket. Uh the link takes us to the moment where they started the ticket. And in a shorter session, it's usually just a few hops back to where they encountered the trouble that they wrote in about.

So you can watch, see what they were doing, uh have an idea about their expectations, uh and then you'll notice problems. uh for example, this user just disabled formula mode probably without understanding uh the effects that that would have uh on the output in this insight. So that's a situation where it's pretty easy just from watching to see what went wrong.

Other times it might not be something that the user did, it might be something going on in uh your app. So you can have a look here in inspector. Uh you can uh turn on and off uh the details uh such as uh what we are able to capture from the console. Um the events uh what we're able to capture on the network tab etc.

Um you can get a detailed look at uh the properties, the metadata, the flags that were involved, uh what elements uh were particularly involved in this part of the capture person properties if you are capturing identified events, set once properties, debug properties, etc., etc., etc. I'm not going to drill down into all that in this video because it would be pretty long.

So, to learn how to add links to session recordings to your own support tickets from your own product, uh go to our docs and tutorials and search for how to add session replays to Zenesk. Uh Ian's got a great document he's written here that shows you how to do it. Uh has uh code examples.

It walks you through the whole thing. While this example is particular to Zenesk, you can extrapolate this for pretty much any system or platform that you're using for support. And um it will uh save you a lot of time and it will make your users happy because they will feel like you're psychic.

Enjoy. Thanks for watching. Take care.
